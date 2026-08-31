// v0.1.2 — index.ts `dispatch` shell wiring. `registerCommand`'s handler is a
// thin `dispatch(args, ctx, buildCommandPorts(ctx))` call; this file exercises
// `dispatch` itself against the same fake ctx/ports convention as
// tests/index.add.test.ts, never importing the Pi runtime. Covers: the bare
// (no-subcommand) root menu, `add` with no URL prompting for one (from the
// menu or typed bare), and that typed subcommands + the unknown-subcommand
// usage notify are unchanged.

import { describe, expect, it, vi } from "vitest";
import { dispatch, type AddContext, type AddPorts } from "../extensions/local-models/index.ts";
import type { FetchLike } from "../extensions/local-models/detect.ts";
import type { WriterPorts } from "../extensions/local-models/models-writer.ts";
import type { StatePorts } from "../extensions/local-models/state.ts";
import type { VModelsFields, PropsFields, ContextPorts } from "../extensions/local-models/context.ts";

function fakeCtx({ hasUI = true }: { hasUI?: boolean } = {}): AddContext & {
  select: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  editor: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
} {
  // Three independent dialogs share this one fake, dispatched by title: the
  // root "Local models" menu (v0.1.2), the "Server kind" picker, and the
  // batched "Context window for ..." picker (v0.1.1 hotfix item 3b).
  const select = vi.fn(async (title: string) => {
    if (title === "Local models") {
      return "Add a Server…";
    }
    if (title.startsWith("Context window")) {
      return "32k (32768)";
    }
    return "mlx-serve";
  });
  const confirm = vi.fn(async () => true);
  // Two independent editor dialogs share this fake: the new "Server base
  // URL" prefill prompt (v0.1.2) and the Custom… contextWindow editor.
  const editor = vi.fn(async (title: string) => {
    if (title === "Server base URL") {
      return "http://localhost:11234";
    }
    return "32768";
  });
  const notify = vi.fn();
  return {
    hasUI,
    ui: {
      select,
      confirm,
      editor,
      notify,
      setWorkingMessage: vi.fn(),
      setWorkingVisible: vi.fn(),
    },
    select,
    confirm,
    editor,
    notify,
  };
}

function fakeWriterPorts(
  files: Record<string, string> = {},
  options: { now?: number; verify?: WriterPorts["verifyWritten"] } = {},
): WriterPorts & { files: Record<string, string> } {
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
    now: () => options.now ?? 1000,
    verifyWritten: options.verify ?? (async () => ({ ok: true as const })),
  };
}

function fakeStatePorts(initial?: string): StatePorts & { writes: string[] } {
  let stored = initial;
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

const noLlamaSwapConfig: ContextPorts = { readLlamaSwapConfig: async () => undefined };

/** Fixed-response fetch for `add`'s single-URL probe — ignores the URL. */
function reachableFetch(modelIds: string[]): FetchLike {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: modelIds.map((id) => ({ id })) }),
  })) as unknown as FetchLike;
}

/** URL-keyed fetch for `list`/`prune`, which probe every known base URL. */
function reachableFetchByUrl(byUrl: Record<string, string[]>): FetchLike {
  return vi.fn(async (url: string) => {
    for (const [baseUrl, modelIds] of Object.entries(byUrl)) {
      if (url.startsWith(baseUrl)) {
        return { ok: true, status: 200, json: async () => ({ data: modelIds.map((id) => ({ id })) }) };
      }
    }
    throw new Error("ECONNREFUSED");
  }) as unknown as FetchLike;
}

function basePorts(overrides: Partial<AddPorts> = {}): AddPorts {
  return {
    fetch: reachableFetch(["qwen3-4b"]),
    fetchVModels: vi.fn(async () => ({}) as Record<string, VModelsFields>),
    fetchProps: vi.fn(async () => undefined as PropsFields | undefined),
    contextPorts: noLlamaSwapConfig,
    writer: { path: "/pi/agent/models.json", ports: fakeWriterPorts() },
    state: fakeStatePorts(),
    ...overrides,
  };
}

describe("dispatch — bare command (no subcommand)", () => {
  it("hasUI: opens the root menu with the three labels in order", async () => {
    const ctx = fakeCtx();
    ctx.select.mockImplementation(async (title: string) => (title === "Local models" ? undefined : "mlx-serve"));
    const ports = basePorts();

    await dispatch("", ctx, ports);

    expect(ctx.select).toHaveBeenCalledWith("Local models", ["Add a Server…", "List Servers", "Prune Unserved Models"]);
  });

  it("cancel at the menu: returns quietly — no notify, no write", async () => {
    const ctx = fakeCtx();
    ctx.select.mockImplementation(async (title: string) => (title === "Local models" ? undefined : "mlx-serve"));
    const ports = basePorts();

    await dispatch("", ctx, ports);

    expect(ctx.notify).not.toHaveBeenCalled();
    expect(Object.keys((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files)).toHaveLength(0);
  });

  it("!hasUI: shows the usage notify, never opens the menu", async () => {
    const ctx = fakeCtx({ hasUI: false });
    const ports = basePorts();

    await dispatch("", ctx, ports);

    expect(ctx.select).not.toHaveBeenCalled();
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("usage: /local-models add <baseUrl> | list | prune"), "warning");
  });

  it("routes 'Add a Server…' to the URL prompt, then continues the add flow", async () => {
    const ctx = fakeCtx();
    const ports = basePorts();

    await dispatch("", ctx, ports);

    expect(ctx.editor).toHaveBeenCalledWith("Server base URL", "http://localhost:");
    expect(ports.fetch).toHaveBeenCalled();
    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"]).toBeDefined();
  });

  it("routes 'List Servers' to list — probes every known Server", async () => {
    const ctx = fakeCtx();
    ctx.select.mockImplementation(async (title: string) => (title === "Local models" ? "List Servers" : "mlx-serve"));
    const writer = fakeWriterPorts({
      "/pi/agent/models.json": JSON.stringify({ providers: { "mlx-serve": { baseUrl: "http://localhost:11234/v1", models: [] } } }),
    });
    const ports = basePorts({
      writer: { path: "/pi/agent/models.json", ports: writer },
      fetch: reachableFetchByUrl({ "http://localhost:11234/v1": ["qwen3-4b"] }),
    });

    await dispatch("", ctx, ports);

    expect(ports.fetch).toHaveBeenCalled();
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("reachable"), "info");
  });

  it("routes 'Prune Unserved Models' to prune — reads models.json", async () => {
    const ctx = fakeCtx();
    ctx.select.mockImplementation(async (title: string) => (title === "Local models" ? "Prune Unserved Models" : "mlx-serve"));
    const readFile = vi.fn(async () => JSON.stringify({ providers: {} }));
    const writer = fakeWriterPorts();
    writer.readFile = readFile;
    const ports = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer } });

    await dispatch("", ctx, ports);

    expect(readFile).toHaveBeenCalledWith("/pi/agent/models.json");
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("No local Providers"), "info");
  });
});

describe("dispatch — add with no URL (from the menu or typed bare)", () => {
  it("typed 'add' with no URL: prompts with the http://localhost: prefill, then continues the add flow", async () => {
    const ctx = fakeCtx();
    const ports = basePorts();

    await dispatch("add", ctx, ports);

    expect(ctx.editor).toHaveBeenCalledWith("Server base URL", "http://localhost:");
    expect(ports.fetch).toHaveBeenCalled();
    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"]).toBeDefined();
  });

  it("cancel at the prompt (editor returns undefined): notifies 'Registration cancelled.' only, never probes", async () => {
    const ctx = fakeCtx();
    ctx.editor.mockImplementation(async () => undefined);
    const ports = basePorts();

    await dispatch("add", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith("Registration cancelled.", "info");
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    expect(ports.fetch).not.toHaveBeenCalled();
  });

  it("empty/whitespace-only answer at the prompt: same quiet 'Registration cancelled.' path as a real cancel", async () => {
    const ctx = fakeCtx();
    ctx.editor.mockImplementation(async () => "   ");
    const ports = basePorts();

    await dispatch("add", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith("Registration cancelled.", "info");
    expect(ports.fetch).not.toHaveBeenCalled();
  });

  it("invalid URL entered at the prompt still gets the existing friendly error (R3-002)", async () => {
    const ctx = fakeCtx();
    ctx.editor.mockImplementation(async () => "::::not a url");
    const ports = basePorts();

    await dispatch("add", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("not a valid"), "error");
  });
});

describe("dispatch — typed subcommands and unknown-subcommand usage are unchanged", () => {
  it("'add <url>' still goes straight to the add flow — no prompt, no menu", async () => {
    const ctx = fakeCtx();
    const ports = basePorts();

    await dispatch("add localhost:11234", ctx, ports);

    expect(ctx.editor).not.toHaveBeenCalledWith("Server base URL", expect.anything());
    expect(ctx.select).not.toHaveBeenCalledWith("Local models", expect.anything());
    expect(ports.fetch).toHaveBeenCalled();
  });

  it("'list' still probes directly — no menu", async () => {
    const ctx = fakeCtx();
    const writer = fakeWriterPorts({
      "/pi/agent/models.json": JSON.stringify({ providers: { "mlx-serve": { baseUrl: "http://localhost:11234/v1", models: [] } } }),
    });
    const ports = basePorts({
      writer: { path: "/pi/agent/models.json", ports: writer },
      fetch: reachableFetchByUrl({ "http://localhost:11234/v1": ["qwen3-4b"] }),
    });

    await dispatch("list", ctx, ports);

    expect(ctx.select).not.toHaveBeenCalledWith("Local models", expect.anything());
    expect(ports.fetch).toHaveBeenCalled();
  });

  it("'prune' still runs directly — no menu", async () => {
    const ctx = fakeCtx();
    const readFile = vi.fn(async () => JSON.stringify({ providers: {} }));
    const writer = fakeWriterPorts();
    writer.readFile = readFile;
    const ports = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer } });

    await dispatch("prune", ctx, ports);

    expect(ctx.select).not.toHaveBeenCalledWith("Local models", expect.anything());
    expect(readFile).toHaveBeenCalledWith("/pi/agent/models.json");
  });

  it("unknown subcommand: usage notify listing add|list|prune, as before", async () => {
    const ctx = fakeCtx();
    const ports = basePorts();

    await dispatch("bogus", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining('"bogus" is not available'), "warning");
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("usage: /local-models add <baseUrl> | list | prune"), "warning");
  });
});
