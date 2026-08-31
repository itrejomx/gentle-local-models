// Phase 8 — index.ts `list` shell wiring (D-004). Known base URLs are the
// union of models.json Providers and plugin-state Servers, deduped by
// baseUrl; each is probed via detect.probeAll (1s); failures render "not
// detected" + the last error, and — for Servers the plugin already tracks in
// state — state.lastError is updated (set on failure, cleared on success).

import { describe, expect, it, vi } from "vitest";
import { list, type ListContext, type ListPorts } from "../extensions/local-models/index.ts";
import type { FetchLike } from "../extensions/local-models/detect.ts";
import type { WriterPorts } from "../extensions/local-models/models-writer.ts";
import type { StatePorts } from "../extensions/local-models/state.ts";
import type { PluginState } from "../extensions/local-models/state.ts";

function fakeCtx(): ListContext & { notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  return {
    ui: { notify, setWorkingMessage: vi.fn(), setWorkingVisible: vi.fn() },
    notify,
  };
}

function fakeWriterPorts(files: Record<string, string> = {}): Pick<WriterPorts, "readFile"> {
  return {
    async readFile(path: string) {
      return files[path];
    },
  };
}

function fakeStatePorts(initial?: PluginState): StatePorts & { writes: string[] } {
  let stored = initial ? JSON.stringify(initial) : undefined;
  const writes: string[] = [];
  return {
    writes,
    async readState() {
      return stored;
    },
    async writeState(contents: string) {
      stored = contents;
      writes.push(contents);
    },
  };
}

function modelsJsonWith(providers: Record<string, { baseUrl: string; models?: Array<{ id: string }> }>): string {
  return JSON.stringify({ providers });
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

describe("list — union of known base URLs, deduped (R1)", () => {
  it("lists a Provider known only from models.json and a Server known only from plugin state", async () => {
    const ctx = fakeCtx();
    const ports: ListPorts = {
      fetch: reachableFetch({ "http://localhost:11234/v1": ["qwen3-4b"], "http://localhost:8080/v1": ["glm-4.5-air"] }),
      writer: { path: "/pi/agent/models.json", ports: fakeWriterPorts({ "/pi/agent/models.json": modelsJsonWith({ mtplx: { baseUrl: "http://localhost:11234/v1" } }) }) },
      state: fakeStatePorts({
        version: 1,
        piVersion: "",
        servers: [{ baseUrl: "http://localhost:8080/v1", kind: "llama-swap", servingMode: "on-demand", providerKey: "llama-swap", owner: "plugin", models: {} }],
      }),
    };

    await list(ctx, ports);

    const messages = ctx.notify.mock.calls.map((call) => call[0]).join("\n");
    expect(messages).toContain("mtplx");
    expect(messages).toContain("http://localhost:11234/v1");
    expect(messages).toContain("llama-swap");
    expect(messages).toContain("http://localhost:8080/v1");
  });

  it("dedupes a Provider that appears in both models.json and plugin state, probing its baseUrl only once", async () => {
    const ctx = fakeCtx();
    const fetchFn = reachableFetch({ "http://localhost:11234/v1": ["qwen3-4b"] });
    const ports: ListPorts = {
      fetch: fetchFn,
      writer: { path: "/pi/agent/models.json", ports: fakeWriterPorts({ "/pi/agent/models.json": modelsJsonWith({ mtplx: { baseUrl: "http://localhost:11234/v1" } }) }) },
      state: fakeStatePorts({
        version: 1,
        piVersion: "",
        servers: [{ baseUrl: "http://localhost:11234/v1", kind: "mtplx", servingMode: "single-model", providerKey: "mtplx", owner: "plugin", models: {} }],
      }),
    };

    await list(ctx, ports);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("shows no-Servers message and never probes when nothing is known", async () => {
    const ctx = fakeCtx();
    const fetchFn = vi.fn() as unknown as FetchLike;
    const ports: ListPorts = {
      fetch: fetchFn,
      writer: { path: "/pi/agent/models.json", ports: fakeWriterPorts() },
      state: fakeStatePorts(),
    };

    await list(ctx, ports);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("No Servers"), "info");
  });
});

describe("list — probe failures render 'not detected' + last error, and update state.lastError", () => {
  it("renders 'not detected' with the probe's error for an unreachable Server", async () => {
    const ctx = fakeCtx();
    const ports: ListPorts = {
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as FetchLike,
      writer: { path: "/pi/agent/models.json", ports: fakeWriterPorts() },
      state: fakeStatePorts({
        version: 1,
        piVersion: "",
        servers: [{ baseUrl: "http://localhost:9999/v1", kind: "generic", servingMode: "single-model", providerKey: "generic", owner: "plugin", models: {} }],
      }),
    };

    await list(ctx, ports);

    const messages = ctx.notify.mock.calls.map((call) => call[0]).join("\n");
    expect(messages).toContain("not detected");
    expect(messages).toContain("ECONNREFUSED");
  });

  it("persists the probe error onto the matching Server's state.lastError", async () => {
    const ctx = fakeCtx();
    const statePorts = fakeStatePorts({
      version: 1,
      piVersion: "",
      servers: [{ baseUrl: "http://localhost:9999/v1", kind: "generic", servingMode: "single-model", providerKey: "generic", owner: "plugin", models: {} }],
    });
    const ports: ListPorts = {
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as FetchLike,
      writer: { path: "/pi/agent/models.json", ports: fakeWriterPorts() },
      state: statePorts,
    };

    await list(ctx, ports);

    const saved = JSON.parse(statePorts.writes.at(-1) as string) as PluginState;
    expect(saved.servers[0].lastError).toBe("ECONNREFUSED");
  });

  it("renders a 200-with-zero-models response as reachable (not 'not detected') and clears lastError — the Server responded (R1-006/R3-021)", async () => {
    const ctx = fakeCtx();
    const statePorts = fakeStatePorts({
      version: 1,
      piVersion: "",
      servers: [
        { baseUrl: "http://localhost:11234/v1", kind: "mtplx", servingMode: "single-model", providerKey: "mtplx", owner: "plugin", lastError: "ECONNREFUSED", models: {} },
      ],
    });
    const ports: ListPorts = {
      fetch: reachableFetch({ "http://localhost:11234/v1": [] }),
      writer: { path: "/pi/agent/models.json", ports: fakeWriterPorts() },
      state: statePorts,
    };

    await list(ctx, ports);

    const messages = ctx.notify.mock.calls.map((call) => call[0]).join("\n");
    expect(messages).toContain("reachable, 0 model(s)");
    expect(messages).not.toContain("not detected");
    const saved = JSON.parse(statePorts.writes.at(-1) as string) as PluginState;
    expect(saved.servers[0].lastError).toBeUndefined();
  });

  it("clears a stale state.lastError once the Server is reachable again", async () => {
    const ctx = fakeCtx();
    const statePorts = fakeStatePorts({
      version: 1,
      piVersion: "",
      servers: [
        { baseUrl: "http://localhost:11234/v1", kind: "mtplx", servingMode: "single-model", providerKey: "mtplx", owner: "plugin", lastError: "ECONNREFUSED", models: {} },
      ],
    });
    const ports: ListPorts = {
      fetch: reachableFetch({ "http://localhost:11234/v1": ["qwen3-4b"] }),
      writer: { path: "/pi/agent/models.json", ports: fakeWriterPorts() },
      state: statePorts,
    };

    await list(ctx, ports);

    const saved = JSON.parse(statePorts.writes.at(-1) as string) as PluginState;
    expect(saved.servers[0].lastError).toBeUndefined();
  });
});
