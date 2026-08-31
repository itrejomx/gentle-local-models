// Phase 7 — index.ts `add` shell wiring (D-003, D-005, D-006, D-007). Every
// core module (detect/presets/context/state/models-writer) stays real here;
// only I/O is stubbed via injected ports, matching the rest of the suite's
// "ports injected, core stays pure" convention. `ctx` is a minimal fake
// covering exactly the ExtensionUIContext surface `add()` uses.

import { describe, expect, it, vi } from "vitest";
import { add, type AddContext, type AddPorts } from "../extensions/local-models/index.ts";
import type { FetchLike } from "../extensions/local-models/detect.ts";
import type { WriterPorts } from "../extensions/local-models/models-writer.ts";
import type { StatePorts } from "../extensions/local-models/state.ts";
import type { VModelsFields, PropsFields, ContextPorts } from "../extensions/local-models/context.ts";
import { realFetchProps, realFetchVModels } from "../extensions/local-models/ports.ts";

function fakeCtx({ hasUI = true }: { hasUI?: boolean } = {}): AddContext & {
  select: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  editor: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
} {
  const select = vi.fn(async () => "mlx-serve");
  const confirm = vi.fn(async () => true);
  const editor = vi.fn(async () => "32768");
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
  options: { now?: number; verify?: WriterPorts["verifyWritten"]; unreadableBackups?: boolean } = {},
): WriterPorts & { files: Record<string, string> } {
  return {
    files,
    async readFile(path: string) {
      if (options.unreadableBackups && path.endsWith(".bak")) {
        return undefined;
      }
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

function reachableFetch(modelIds: string[]): FetchLike {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: modelIds.map((id) => ({ id })) }),
  })) as unknown as FetchLike;
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

describe("add — invalid input (R3-002)", () => {
  it("notifies a friendly error and never probes when the URL is invalid", async () => {
    const ctx = fakeCtx();
    const ports = basePorts();

    await add("", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("not a valid"), "error");
    expect(ports.fetch).not.toHaveBeenCalled();
  });
});

describe("add — unreachable Server", () => {
  it("notifies the probe's error and stops before Server-kind selection", async () => {
    const ctx = fakeCtx();
    const ports = basePorts({
      fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) as unknown as FetchLike,
    });

    await add("localhost:9999", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("localhost:9999"), "error");
    expect(ctx.select).not.toHaveBeenCalled();
  });
});

describe("add — Server-kind selection", () => {
  it("notifies cancellation and never writes when the user cancels the kind picker", async () => {
    const ctx = fakeCtx();
    ctx.select.mockResolvedValue(undefined);
    const ports = basePorts();

    await add("localhost:11234", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("cancelled"), "info");
    expect(Object.keys((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files)).toHaveLength(0);
  });

  it("warns immediately that omlx will rewrite this Provider key", async () => {
    const ctx = fakeCtx();
    ctx.select.mockResolvedValue("omlx");
    const ports = basePorts();

    await add("localhost:11234", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("omlx launch pi"), "warning");
  });

  it("warns immediately that mtplx will rewrite this Provider key", async () => {
    const ctx = fakeCtx();
    ctx.select.mockResolvedValue("mtplx");
    const ports = basePorts();

    await add("localhost:8000", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("mtplx start pi"), "warning");
  });

  it("does not warn about a rewrite for mlx-serve", async () => {
    const ctx = fakeCtx();
    ctx.select.mockResolvedValue("mlx-serve");
    const ports = basePorts();

    await add("localhost:11234", ctx, ports);

    const warnCalls = ctx.notify.mock.calls.filter(([, type]) => type === "warning");
    expect(warnCalls.some(([msg]) => String(msg).includes("rewrit"))).toBe(false);
  });
});

describe("add — per-kind Provider extras (mtplx headers, omlx authHeader)", () => {
  it("writes mtplx's x-mtplx-client header onto the Provider", async () => {
    const ctx = fakeCtx();
    ctx.select.mockResolvedValue("mtplx");
    const writer = fakeWriterPorts();
    const ports = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer } });

    await add("localhost:8000", ctx, ports);

    const written = JSON.parse(writer.files["/pi/agent/models.json"]);
    expect(written.providers.mtplx.headers).toEqual({ "x-mtplx-client": "pi" });
  });

  it("writes omlx's authHeader flag onto the Provider", async () => {
    const ctx = fakeCtx();
    ctx.select.mockResolvedValue("omlx");
    const writer = fakeWriterPorts();
    const ports = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer } });

    await add("localhost:1234", ctx, ports);

    const written = JSON.parse(writer.files["/pi/agent/models.json"]);
    expect(written.providers.omlx.authHeader).toBe(true);
  });
});

describe("add — context resolution guard (D-005)", () => {
  it("never calls context.resolve's sources for a model that already has a recorded contextWindow", async () => {
    const existingFile = JSON.stringify({
      providers: { "mlx-serve": { models: [{ id: "qwen3-4b", name: "qwen3-4b", contextWindow: 131072 }] } },
    });
    const writer = fakeWriterPorts({ "/pi/agent/models.json": existingFile });
    const fetchVModels = vi.fn(async () => ({}) as Record<string, VModelsFields>);
    const fetchProps = vi.fn(async () => undefined as PropsFields | undefined);
    const ctx = fakeCtx();
    const ports = basePorts({
      writer: { path: "/pi/agent/models.json", ports: writer },
      fetchVModels,
      fetchProps,
    });

    await add("localhost:11234", ctx, ports);

    expect(fetchVModels).not.toHaveBeenCalled();
    expect(fetchProps).not.toHaveBeenCalled();
    expect(ctx.editor).not.toHaveBeenCalledWith(expect.stringContaining("contextWindow"), expect.anything());
    const written = JSON.parse(writer.files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].contextWindow).toBe(131072);
  });
});

describe("add — context metadata fetch is bounded and loader-wrapped (R4-005)", () => {
  it("completes to the ask-at-registration prompt when the real ports' metadata fetch never resolves within its timeout", async () => {
    const ctx = fakeCtx();
    ctx.editor.mockResolvedValue("32768");
    const neverResolving: FetchLike = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as FetchLike;
    const ports = basePorts({
      fetchVModels: realFetchVModels(neverResolving, 50),
      fetchProps: realFetchProps(neverResolving, 50),
    });

    await add("localhost:11234", ctx, ports);

    expect(ctx.editor).toHaveBeenCalledWith(expect.stringContaining("contextWindow"), "32768");
    expect(ctx.ui.setWorkingMessage).toHaveBeenCalledWith(expect.stringContaining("Reading context metadata"));
  }, 2000);
});

describe("add — context resolution, verificado source", () => {
  it("resolves contextWindow from /v1/models without prompting, labeled verificado", async () => {
    const ctx = fakeCtx();
    const ports = basePorts({
      fetchVModels: vi.fn(async () => ({ "qwen3-4b": { max_model_len: 8192 } })),
    });

    await add("localhost:11234", ctx, ports);

    expect(ctx.editor).not.toHaveBeenCalledWith(expect.stringContaining("contextWindow"), expect.anything());
    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].contextWindow).toBe(8192);
    const state = JSON.parse((ports.state as StatePorts & { writes: string[] }).writes.at(-1)!);
    expect(state.servers[0].models["qwen3-4b"]).toEqual({ contextLabel: "verificado", contextSource: "v1/models" });
  });
});

describe("add — ask-at-registration prompt (D-006)", () => {
  it("accepts the pre-filled 32768 and labels it declarado", async () => {
    const ctx = fakeCtx();
    ctx.editor.mockResolvedValue("32768");
    const ports = basePorts();

    await add("localhost:11234", ctx, ports);

    expect(ctx.editor).toHaveBeenCalledWith(expect.stringContaining("qwen3-4b"), "32768");
    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].contextWindow).toBe(32768);
    const state = JSON.parse((ports.state as StatePorts & { writes: string[] }).writes.at(-1)!);
    expect(state.servers[0].models["qwen3-4b"]).toEqual({ contextLabel: "declarado", contextSource: "prompt" });
  });
});

describe("add — non-interactive / cancelled fallback (D-007)", () => {
  it("omits contextWindow, labels placeholder, and warns by name when the editor is cancelled", async () => {
    const ctx = fakeCtx();
    ctx.editor.mockResolvedValue(undefined);
    const ports = basePorts();

    await add("localhost:11234", ctx, ports);

    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].contextWindow).toBeUndefined();
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("qwen3-4b"), "warning");
    const state = JSON.parse((ports.state as StatePorts & { writes: string[] }).writes.at(-1)!);
    expect(state.servers[0].models["qwen3-4b"]).toEqual({ contextLabel: "placeholder", contextSource: "none" });
  });

  it("takes the same omit+placeholder+warning path without opening a dialog when ctx.hasUI is false", async () => {
    const ctx = fakeCtx({ hasUI: false });
    ctx.editor.mockResolvedValue("32768"); // must never be reached; !hasUI skips the dialog outright
    const ports = basePorts();

    await add("localhost:11234", ctx, ports);

    expect(ctx.editor).not.toHaveBeenCalled();
    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].contextWindow).toBeUndefined();
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("qwen3-4b"), "warning");
  });
});

describe("add — validates the context prompt answer (R3-016)", () => {
  it('"" is rejected: no contextWindow 0, placeholder path, no crash', async () => {
    const ctx = fakeCtx();
    ctx.editor.mockResolvedValue("");
    const ports = basePorts();

    await add("localhost:11234", ctx, ports);

    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].contextWindow).toBeUndefined();
    const state = JSON.parse((ports.state as StatePorts & { writes: string[] }).writes.at(-1)!);
    expect(state.servers[0].models["qwen3-4b"]).toEqual({ contextLabel: "placeholder", contextSource: "none" });
  });

  it('"abc" is rejected: placeholder path with a warning naming the rejected input', async () => {
    const ctx = fakeCtx();
    ctx.editor.mockResolvedValue("abc");
    const ports = basePorts();

    await add("localhost:11234", ctx, ports);

    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].contextWindow).toBeUndefined();
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("abc"), "warning");
    const state = JSON.parse((ports.state as StatePorts & { writes: string[] }).writes.at(-1)!);
    expect(state.servers[0].models["qwen3-4b"]).toEqual({ contextLabel: "placeholder", contextSource: "none" });
  });

  it('"0" and negative values are rejected like cancel', async () => {
    const ctx = fakeCtx();
    ctx.editor.mockResolvedValue("0");
    const ports = basePorts();

    await add("localhost:11234", ctx, ports);

    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].contextWindow).toBeUndefined();
    const state = JSON.parse((ports.state as StatePorts & { writes: string[] }).writes.at(-1)!);
    expect(state.servers[0].models["qwen3-4b"]).toEqual({ contextLabel: "placeholder", contextSource: "none" });
  });

  it('" 65536 " (surrounding whitespace) is trimmed and declared', async () => {
    const ctx = fakeCtx();
    ctx.editor.mockResolvedValue(" 65536 ");
    const ports = basePorts();

    await add("localhost:11234", ctx, ports);

    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].contextWindow).toBe(65536);
    const state = JSON.parse((ports.state as StatePorts & { writes: string[] }).writes.at(-1)!);
    expect(state.servers[0].models["qwen3-4b"]).toEqual({ contextLabel: "declarado", contextSource: "prompt" });
  });
});

describe("add — thinkingFormat proposal and override", () => {
  it("proposes the family heuristic and lets the user override it before write", async () => {
    const ctx = fakeCtx();
    ctx.editor.mockImplementation(async (title: string) => (title.includes("contextWindow") ? "32768" : "deepseek"));
    const ports = basePorts();

    await add("localhost:11234", ctx, ports);

    expect(ctx.editor).toHaveBeenCalledWith(expect.stringContaining("thinkingFormat"), "qwen");
    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].compat).toEqual({ thinkingFormat: "deepseek" });
  });

  it("keeps the heuristic proposal when the override editor is cancelled", async () => {
    const ctx = fakeCtx();
    ctx.editor.mockImplementation(async (title: string) => (title.includes("contextWindow") ? "32768" : undefined));
    const ports = basePorts();

    await add("localhost:11234", ctx, ports);

    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].compat).toEqual({ thinkingFormat: "qwen" });
  });

  it("omits thinkingFormat entirely for an unmatched family, without prompting for it", async () => {
    const ctx = fakeCtx();
    const ports = basePorts({ fetch: reachableFetch(["llama-3.1-8b"]) });

    await add("localhost:11234", ctx, ports);

    expect(ctx.editor).not.toHaveBeenCalledWith(expect.stringContaining("thinkingFormat"), expect.anything());
    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].compat).toBeUndefined();
    expect(written.providers["mlx-serve"].models[0].reasoning).toBeUndefined();
  });
});

describe("add — reasoning becomes user-confirmed, never heuristic-derived (R3-015)", () => {
  it("decline: written model has NO reasoning and NO thinkingFormat", async () => {
    const ctx = fakeCtx();
    ctx.confirm.mockResolvedValue(false);
    ctx.editor.mockImplementation(async (title: string) => (title.includes("contextWindow") ? "32768" : undefined));
    const ports = basePorts({ fetch: reachableFetch(["qwen2.5-coder-7b-instruct"]) });

    await add("localhost:11234", ctx, ports);

    expect(ctx.confirm).toHaveBeenCalledWith(
      expect.stringContaining("reasoning"),
      expect.stringContaining("qwen2.5-coder-7b-instruct"),
    );
    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].reasoning).toBeUndefined();
    expect(written.providers["mlx-serve"].models[0].compat).toBeUndefined();
  });

  it("accept: written model has BOTH reasoning:true and compat.thinkingFormat", async () => {
    const ctx = fakeCtx();
    ctx.confirm.mockResolvedValue(true);
    ctx.editor.mockImplementation(async (title: string) => (title.includes("contextWindow") ? "32768" : undefined));
    const ports = basePorts({ fetch: reachableFetch(["qwen2.5-coder-7b-instruct"]) });

    await add("localhost:11234", ctx, ports);

    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].reasoning).toBe(true);
    expect(written.providers["mlx-serve"].models[0].compat).toEqual({ thinkingFormat: "qwen" });
  });

  it("mlx-serve-style declared capabilities: reasoning true without prompting", async () => {
    const ctx = fakeCtx();
    ctx.editor.mockImplementation(async (title: string) => (title.includes("contextWindow") ? "32768" : undefined));
    const ports = basePorts({
      fetch: reachableFetch(["qwen2.5-coder-7b-instruct"]),
      fetchVModels: vi.fn(async () => ({ "qwen2.5-coder-7b-instruct": { max_model_len: 8192, capabilities: ["reasoning"] } })),
    });

    await add("localhost:11234", ctx, ports);

    expect(ctx.confirm).not.toHaveBeenCalled();
    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].reasoning).toBe(true);
    expect(written.providers["mlx-serve"].models[0].compat).toEqual({ thinkingFormat: "qwen" });
  });

  it("non-interactive (!hasUI): proposes nothing, omits both, warns naming the model", async () => {
    const ctx = fakeCtx({ hasUI: false });
    const ports = basePorts({ fetch: reachableFetch(["qwen3-4b"]) });

    await add("localhost:11234", ctx, ports);

    expect(ctx.confirm).not.toHaveBeenCalled();
    const written = JSON.parse((ports.writer.ports as WriterPorts & { files: Record<string, string> }).files["/pi/agent/models.json"]);
    expect(written.providers["mlx-serve"].models[0].reasoning).toBeUndefined();
    expect(written.providers["mlx-serve"].models[0].compat).toBeUndefined();
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("qwen3-4b"), "warning");
  });
});

describe("add — re-add merges into existing state (R3-017)", () => {
  it("preserves the first run's ModelLabel entries and updates the server record in place, not duplicated", async () => {
    const ctx = fakeCtx();
    ctx.editor.mockImplementation(async (title: string) => (title.includes("contextWindow") ? "32768" : undefined));
    const writer = fakeWriterPorts();
    const firstState = fakeStatePorts();
    const firstPorts = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer }, state: firstState });

    await add("localhost:11234", ctx, firstPorts);

    const persisted = firstState.writes.at(-1)!;
    const afterFirstRun = JSON.parse(persisted);
    expect(afterFirstRun.servers).toHaveLength(1);
    expect(afterFirstRun.servers[0].models["qwen3-4b"]).toEqual({ contextLabel: "declarado", contextSource: "prompt" });

    // Second run against the SAME Server: `models.json` already carries
    // qwen3-4b's contextWindow (fill-never-overwrite never clears it), so
    // D-005 skips context resolution/prompting entirely this run and writes
    // no new label for it — the merge must fall through to the
    // `existingIdx >= 0` branch and carry the first run's label through
    // unchanged, not drop or relabel it.
    ctx.notify.mockClear();
    ctx.editor.mockClear();
    const secondState = fakeStatePorts(persisted);
    const secondPorts = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer }, state: secondState });

    await add("localhost:11234", ctx, secondPorts);

    expect(ctx.editor).not.toHaveBeenCalledWith(expect.stringContaining("contextWindow"), expect.anything());
    const afterSecondRun = JSON.parse(secondState.writes.at(-1)!);
    expect(afterSecondRun.servers).toHaveLength(1);
    expect(afterSecondRun.servers[0].models["qwen3-4b"]).toEqual({ contextLabel: "declarado", contextSource: "prompt" });
  });
});

describe("add — successful write records plugin-owned state", () => {
  it("saves a new plugin-owned ServerRecord with baseUrl/kind/servingMode/providerKey", async () => {
    const ctx = fakeCtx();
    ctx.select.mockResolvedValue("llama-swap");
    const ports = basePorts({ fetch: reachableFetch(["qwen3-4b"]) });

    await add("localhost:8080", ctx, ports);

    const state = JSON.parse((ports.state as StatePorts & { writes: string[] }).writes.at(-1)!);
    expect(state.servers[0]).toMatchObject({
      baseUrl: "http://localhost:8080/v1",
      kind: "llama-swap",
      providerKey: "llama-swap",
      owner: "plugin",
    });
  });

  it("derives servingMode on-demand when the probe reports more than one model", async () => {
    const ctx = fakeCtx();
    ctx.select.mockResolvedValue("llama-swap");
    const ports = basePorts({ fetch: reachableFetch(["qwen3-4b", "glm-4.5-air"]) });

    await add("localhost:8080", ctx, ports);

    const state = JSON.parse((ports.state as StatePorts & { writes: string[] }).writes.at(-1)!);
    expect(state.servers[0].servingMode).toBe("on-demand");
  });
});

describe("add — guards state persistence after a successful write (R4-006)", () => {
  it("resolves without throwing and notifies both the registration success and the bookkeeping failure", async () => {
    const ctx = fakeCtx();
    const state = fakeStatePorts();
    state.writeState = vi.fn(async () => {
      throw new Error("disk full");
    });
    const ports = basePorts({ state });

    await expect(add("localhost:11234", ctx, ports)).resolves.toBeUndefined();

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("Registered"), "info");
    expect(ctx.notify).toHaveBeenCalledWith(
      expect.stringContaining("plugin bookkeeping failed"),
      "warning",
    );
    const registeredCallIndex = ctx.notify.mock.calls.findIndex(([msg]) => String(msg).includes("Registered"));
    const bookkeepingCallIndex = ctx.notify.mock.calls.findIndex(([msg]) => String(msg).includes("plugin bookkeeping failed"));
    expect(bookkeepingCallIndex).toBeGreaterThan(registeredCallIndex);
  });
});

describe("add — WriteOutcome rendering (every kind gets a distinct message)", () => {
  it("written: notifies success and surfaces lint warnings", async () => {
    const existingFile = JSON.stringify({
      providers: { "mlx-serve": { compat: { bogusKey: true }, models: [] } },
    });
    const ctx = fakeCtx();
    const writer = fakeWriterPorts({ "/pi/agent/models.json": existingFile });
    const ports = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer } });

    await add("localhost:11234", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("Registered"), "info");
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("bogusKey"), "warning");
  });

  it("refused: notifies a distinct comments-refusal message and never saves state", async () => {
    const existingFile = '// hand-edited\n{"providers":{}}';
    const ctx = fakeCtx();
    const writer = fakeWriterPorts({ "/pi/agent/models.json": existingFile });
    const state = fakeStatePorts();
    const ports = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer }, state });

    await add("localhost:11234", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("comments"), "error");
    expect(state.writes).toHaveLength(0);
  });

  it("invalid: notifies errors and available backups, and never saves state", async () => {
    const existingFile = "{ not json";
    const ctx = fakeCtx();
    const writer = fakeWriterPorts({ "/pi/agent/models.json": existingFile });
    const state = fakeStatePorts();
    const ports = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer }, state });

    await add("localhost:11234", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("invalid"), "error");
    expect(state.writes).toHaveLength(0);
  });

  it("restored: notifies the restore and its verification result", async () => {
    const existingFile = JSON.stringify({ providers: {} });
    const ctx = fakeCtx();
    const writer = fakeWriterPorts(
      { "/pi/agent/models.json": existingFile },
      { verify: async () => ({ ok: false, error: "empty provider map" }) },
    );
    const ports = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer } });

    await add("localhost:11234", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringMatching(/restored/i), "error");
  });

  it("restored + verified: says the backup restored and verified, not a false failure (v0.1.1 hotfix item 2)", async () => {
    // Reproduces the live E2E bug: models.json restored to a byte-identical
    // backup, but the old post-restore check re-verified against the NEW
    // models that were just rolled back — always absent post-restore — so it
    // always reported "Restore verification failed" even here, on a genuinely
    // perfect restore.
    const existingFile = JSON.stringify({ providers: {} });
    const ctx = fakeCtx();
    const writer = fakeWriterPorts(
      { "/pi/agent/models.json": existingFile },
      {
        verify: async (_providerKey: string, modelIds: string[]) =>
          modelIds.length === 0 ? { ok: true as const } : { ok: false as const, error: "empty provider map" },
      },
    );
    const ports = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer } });

    await add("localhost:11234", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("Backup restored and verified"), "error");
  });

  it("rolled-back: notifies distinctly when no backup existed to restore", async () => {
    const ctx = fakeCtx();
    const writer = fakeWriterPorts({}, { verify: async () => ({ ok: false, error: "empty provider map" }) });
    const ports = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer } });

    await add("localhost:11234", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("rolled back"), "error");
  });

  it("restore-failed: notifies that recovery itself failed, leaving the bad write in place", async () => {
    const existingFile = JSON.stringify({ providers: {} });
    const ctx = fakeCtx();
    const writer = fakeWriterPorts(
      { "/pi/agent/models.json": existingFile },
      { verify: async () => ({ ok: false, error: "empty provider map" }), unreadableBackups: true },
    );
    const ports = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer } });

    await add("localhost:11234", ctx, ports);

    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining("restoring"), "error");
  });

  it("write-failed/restore/unverified-write (R2-006): names the file, the backup, and instructs manual inspection", async () => {
    const existingFile = JSON.stringify({ providers: {} });
    const ctx = fakeCtx();
    const writer = fakeWriterPorts(
      { "/pi/agent/models.json": existingFile },
      { verify: async () => ({ ok: false, error: "empty provider map" }) },
    );
    let listBackupsCalls = 0;
    const originalListBackups = writer.listBackups.bind(writer);
    writer.listBackups = vi.fn(async (path: string) => {
      listBackupsCalls++;
      if (listBackupsCalls > 1) {
        throw new Error("listBackups exploded on retry");
      }
      return originalListBackups(path);
    });
    const ports = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer } });

    await add("localhost:11234", ctx, ports);

    const [message] = ctx.notify.mock.calls.find(([, type]) => type === "error") ?? [];
    const text = String(message);
    // Must name the models.json path AS THE THING THAT MAY BE CORRUPTED — not
    // merely as a substring of the backup filename (the old generic message
    // never used the word "corrupted" at all, only the enum "unverified-write").
    expect(text).toContain("/pi/agent/models.json may be corrupted");
    expect(text).toContain("/pi/agent/models.json.1000.bak");
    expect(text).toMatch(/inspect/i);
  });

  it("write-failed (R3-013): notifies the failing stage and the file state left behind", async () => {
    const ctx = fakeCtx();
    const writer = fakeWriterPorts();
    writer.readFile = vi.fn(async () => {
      throw new Error("disk exploded");
    });
    const ports = basePorts({ writer: { path: "/pi/agent/models.json", ports: writer } });

    await add("localhost:11234", ctx, ports);

    const [message] = ctx.notify.mock.calls.find(([, type]) => type === "error") ?? [];
    expect(String(message)).toContain("read");
    expect(String(message)).toContain("untouched");
  });
});
