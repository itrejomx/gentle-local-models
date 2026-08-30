// Phase 8 — index.ts `prune` shell wiring (D-004, R2). `prune` works on ANY
// local Provider in models.json — including ones the plugin never wrote —
// shows each candidate's ownership, identifies Unserved Models by comparing
// a Provider's registered models against a live probe, and asks exactly ONE
// confirmation for the whole run before writing. The write itself goes
// through models-writer's guarded commit-style flow (backup before any
// change, mirror validation, read-back verify).

import { describe, expect, it, vi } from "vitest";
import { prune, type PruneContext, type PrunePorts } from "../extensions/local-models/index.ts";
import type { FetchLike } from "../extensions/local-models/detect.ts";
import type { WriterPorts } from "../extensions/local-models/models-writer.ts";
import type { PluginState, StatePorts } from "../extensions/local-models/state.ts";

function fakeCtx(): PruneContext & { confirm: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> } {
  const confirm = vi.fn(async () => true);
  const notify = vi.fn();
  return {
    hasUI: true,
    ui: { confirm, notify, setWorkingMessage: vi.fn(), setWorkingVisible: vi.fn() },
    confirm,
    notify,
  };
}

function fakeWriterPorts(files: Record<string, string> = {}): WriterPorts & { files: Record<string, string> } {
  return {
    files,
    async readFile(path: string) {
      return files[path];
    },
    async writeFile(path: string, contents: string) {
      files[path] = contents;
    },
    async deleteFile(path: string) {
      delete files[path];
    },
    async listBackups(path: string) {
      const prefix = `${path}.`;
      return Object.keys(files).filter((p) => p.startsWith(prefix) && p.endsWith(".bak"));
    },
    now: () => 1000,
    verifyWritten: async () => ({ ok: true as const }),
  };
}

function fakeStatePorts(initial?: PluginState): StatePorts {
  const stored = initial ? JSON.stringify(initial) : undefined;
  return {
    async readState() {
      return stored;
    },
    async writeState() {},
  };
}

function reachableFetch(byUrl: Record<string, string[]>): FetchLike {
  return vi.fn(async (url: string) => {
    for (const [baseUrl, modelIds] of Object.entries(byUrl)) {
      if (url.startsWith(baseUrl)) {
        return { ok: true, status: 200, json: async () => ({ data: modelIds.map((id) => ({ id })) }) };
      }
    }
    throw new Error("ECONNREFUSED");
  }) as unknown as FetchLike;
}

const MODELS_JSON_PATH = "/pi/agent/models.json";

function modelsJsonFile(providers: Record<string, { baseUrl: string; models: Array<{ id: string }> }>): string {
  return JSON.stringify({
    providers: Object.fromEntries(
      Object.entries(providers).map(([key, p]) => [key, { baseUrl: p.baseUrl, apiKey: "local", models: p.models.map((m) => ({ id: m.id, name: m.id, maxTokens: 4096 })) }]),
    ),
  });
}

describe("prune — any local Provider, ownership per row, Unserved Models via live probe (R2)", () => {
  it("prunes an Unserved Model from a hand-curated (external) Provider the plugin never wrote", async () => {
    const ctx = fakeCtx();
    const writerPorts = fakeWriterPorts({
      [MODELS_JSON_PATH]: modelsJsonFile({
        lmstudio: { baseUrl: "http://localhost:1234/v1", models: [{ id: "served-model" }, { id: "gone-model" }] },
      }),
    });
    const ports: PrunePorts = {
      fetch: reachableFetch({ "http://localhost:1234/v1": ["served-model"] }),
      writer: { path: MODELS_JSON_PATH, ports: writerPorts },
      state: fakeStatePorts(), // no state record ⇒ owner is "unknown" (external, per ownerOf's default)
    };

    await prune(ctx, ports);

    expect(ctx.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.confirm.mock.calls[0][1]).toContain("unknown");
    const written = JSON.parse(writerPorts.files[MODELS_JSON_PATH]) as { providers: Record<string, { models: Array<{ id: string }> }> };
    const modelIds = written.providers.lmstudio.models.map((m) => m.id);
    expect(modelIds).toEqual(["served-model"]);
  });

  it("shows ownership per row across a plugin-owned and an external local Provider, still with one confirmation", async () => {
    const ctx = fakeCtx();
    const writerPorts = fakeWriterPorts({
      [MODELS_JSON_PATH]: modelsJsonFile({
        mtplx: { baseUrl: "http://localhost:11234/v1", models: [{ id: "gone-a" }] },
        lmstudio: { baseUrl: "http://localhost:1234/v1", models: [{ id: "gone-b" }] },
      }),
    });
    const ports: PrunePorts = {
      fetch: reachableFetch({ "http://localhost:11234/v1": [], "http://localhost:1234/v1": [] }),
      writer: { path: MODELS_JSON_PATH, ports: writerPorts },
      state: fakeStatePorts({
        version: 1,
        piVersion: "",
        servers: [{ baseUrl: "http://localhost:11234/v1", kind: "mtplx", servingMode: "single-model", providerKey: "mtplx", owner: "plugin", models: {} }],
      }),
    };

    await prune(ctx, ports);

    expect(ctx.confirm).toHaveBeenCalledTimes(1);
    const message = ctx.confirm.mock.calls[0][1] as string;
    expect(message).toContain("mtplx");
    expect(message).toContain("plugin");
    expect(message).toContain("lmstudio");
    expect(message).toContain("unknown");
  });

  it("never offers a non-local (LAN) Provider for pruning", async () => {
    const ctx = fakeCtx();
    const writerPorts = fakeWriterPorts({
      [MODELS_JSON_PATH]: modelsJsonFile({
        remote: { baseUrl: "http://192.168.1.50:8080/v1", models: [{ id: "gone-model" }] },
      }),
    });
    const ports: PrunePorts = {
      fetch: reachableFetch({}),
      writer: { path: MODELS_JSON_PATH, ports: writerPorts },
      state: fakeStatePorts(),
    };

    await prune(ctx, ports);

    expect(ctx.confirm).not.toHaveBeenCalled();
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("No local"), "info");
  });

  it("finds no Unserved Models and never confirms when every registered model is still live", async () => {
    const ctx = fakeCtx();
    const writerPorts = fakeWriterPorts({
      [MODELS_JSON_PATH]: modelsJsonFile({
        mtplx: { baseUrl: "http://localhost:11234/v1", models: [{ id: "still-served" }] },
      }),
    });
    const ports: PrunePorts = {
      fetch: reachableFetch({ "http://localhost:11234/v1": ["still-served"] }),
      writer: { path: MODELS_JSON_PATH, ports: writerPorts },
      state: fakeStatePorts(),
    };

    await prune(ctx, ports);

    expect(ctx.confirm).not.toHaveBeenCalled();
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("No Unserved Models"), "info");
  });

  it("writes a backup before removing anything", async () => {
    const ctx = fakeCtx();
    const preImage = modelsJsonFile({ mtplx: { baseUrl: "http://localhost:11234/v1", models: [{ id: "gone-model" }] } });
    const writerPorts = fakeWriterPorts({ [MODELS_JSON_PATH]: preImage });
    const ports: PrunePorts = {
      fetch: reachableFetch({ "http://localhost:11234/v1": [] }),
      writer: { path: MODELS_JSON_PATH, ports: writerPorts },
      state: fakeStatePorts(),
    };

    await prune(ctx, ports);

    const backupPaths = Object.keys(writerPorts.files).filter((p) => p.endsWith(".bak"));
    expect(backupPaths).toHaveLength(1);
    expect(writerPorts.files[backupPaths[0]]).toBe(preImage);
  });

  it("cancels and leaves the file untouched when the user declines the single confirmation", async () => {
    const ctx = fakeCtx();
    ctx.confirm.mockResolvedValue(false);
    const preImage = modelsJsonFile({ mtplx: { baseUrl: "http://localhost:11234/v1", models: [{ id: "gone-model" }] } });
    const writerPorts = fakeWriterPorts({ [MODELS_JSON_PATH]: preImage });
    const ports: PrunePorts = {
      fetch: reachableFetch({ "http://localhost:11234/v1": [] }),
      writer: { path: MODELS_JSON_PATH, ports: writerPorts },
      state: fakeStatePorts(),
    };

    await prune(ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("cancelled"), "info");
    expect(writerPorts.files[MODELS_JSON_PATH]).toBe(preImage);
    expect(Object.keys(writerPorts.files)).toHaveLength(1);
  });

  it("never prunes non-interactively — warns naming the candidates instead of confirming", async () => {
    const ctx = fakeCtx();
    ctx.hasUI = false;
    const preImage = modelsJsonFile({ mtplx: { baseUrl: "http://localhost:11234/v1", models: [{ id: "gone-model" }] } });
    const writerPorts = fakeWriterPorts({ [MODELS_JSON_PATH]: preImage });
    const ports: PrunePorts = {
      fetch: reachableFetch({ "http://localhost:11234/v1": [] }),
      writer: { path: MODELS_JSON_PATH, ports: writerPorts },
      state: fakeStatePorts(),
    };

    await prune(ctx, ports);

    expect(ctx.confirm).not.toHaveBeenCalled();
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("gone-model"), "warning");
    expect(writerPorts.files[MODELS_JSON_PATH]).toBe(preImage);
  });
});
