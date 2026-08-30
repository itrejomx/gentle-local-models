import { describe, expect, it } from "vitest";
import {
  load,
  save,
  ownerOf,
  labelOf,
  withLabel,
  withLastError,
  type PluginState,
  type StatePorts,
} from "../extensions/local-models/state.ts";

function memoryPorts(initial?: string): StatePorts & { writes: string[] } {
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

const fullState: PluginState = {
  version: 1,
  piVersion: "0.9.2",
  servers: [
    {
      baseUrl: "http://localhost:11234/v1",
      kind: "mlx-serve",
      servingMode: "single-model",
      providerKey: "mlx-serve-local",
      owner: "plugin",
      lastError: "timed out after 1000ms",
      models: {
        "qwen3-4b": { contextLabel: "verificado", contextSource: "v1/models" },
      },
    },
    {
      baseUrl: "http://localhost:8080/v1",
      kind: "llama-swap",
      servingMode: "on-demand",
      providerKey: "llama-swap-local",
      owner: "external",
      models: {
        "glm-4.5-air": { contextLabel: "declarado", contextSource: "prompt" },
      },
    },
  ],
};

describe("load — missing and corrupted state files never crash (D-002)", () => {
  it("returns a fresh empty state when no file exists yet", async () => {
    const ports = memoryPorts(undefined);

    const state = await load(ports);

    expect(state).toEqual({ version: 1, piVersion: "", servers: [] });
  });

  it("recovers to a fresh empty state when the file contains invalid JSON, without writing to it", async () => {
    const ports = memoryPorts("{ this is not json");

    const state = await load(ports);

    expect(state).toEqual({ version: 1, piVersion: "", servers: [] });
    expect(ports.writes).toEqual([]);
  });

  it("recovers to a fresh empty state when the parsed JSON is structurally invalid (servers is not an array)", async () => {
    const ports = memoryPorts(JSON.stringify({ version: 1, piVersion: "0.9.2", servers: "oops" }));

    const state = await load(ports);

    expect(state).toEqual({ version: 1, piVersion: "", servers: [] });
    expect(ports.writes).toEqual([]);
  });

  it("tolerates unknown top-level keys in an otherwise valid state file", async () => {
    const raw = JSON.stringify({ ...fullState, futureField: { anything: true } });
    const ports = memoryPorts(raw);

    const state = await load(ports);

    expect(state.version).toBe(1);
    expect(state.piVersion).toBe("0.9.2");
    expect(state.servers).toHaveLength(2);
  });
});

describe("save/load — round trip (D-002)", () => {
  it("round-trips a full PluginState including owner, lastError, and per-model context labels", async () => {
    const ports = memoryPorts();

    await save(ports, fullState);
    const loaded = await load(ports);

    expect(loaded).toEqual(fullState);
  });
});

describe("ownerOf — ownership queries (D-004)", () => {
  it("returns the recorded owner for a known Provider key", () => {
    expect(ownerOf(fullState, "mlx-serve-local")).toBe("plugin");
    expect(ownerOf(fullState, "llama-swap-local")).toBe("external");
  });

  it("defaults to 'unknown' when the Provider key is not present in state", () => {
    expect(ownerOf(fullState, "never-registered")).toBe("unknown");
  });
});

describe("labelOf / withLabel — per-(provider,model) context labels", () => {
  it("returns undefined when no label is recorded for that model", () => {
    expect(labelOf(fullState, "mlx-serve-local", "unknown-model")).toBeUndefined();
    expect(labelOf(fullState, "never-registered", "qwen3-4b")).toBeUndefined();
  });

  it("returns the recorded label for a known (provider, model) pair", () => {
    expect(labelOf(fullState, "mlx-serve-local", "qwen3-4b")).toEqual({
      contextLabel: "verificado",
      contextSource: "v1/models",
    });
  });

  it("withLabel sets a new model's label without mutating the original state", () => {
    const updated = withLabel(fullState, "llama-swap-local", "new-model", {
      contextLabel: "placeholder",
      contextSource: "none",
    });

    expect(labelOf(updated, "llama-swap-local", "new-model")).toEqual({
      contextLabel: "placeholder",
      contextSource: "none",
    });
    expect(labelOf(fullState, "llama-swap-local", "new-model")).toBeUndefined();
  });

  it("withLabel overwrites an existing model's label for the matching Provider only", () => {
    const updated = withLabel(fullState, "mlx-serve-local", "qwen3-4b", {
      contextLabel: "declarado",
      contextSource: "prompt",
    });

    expect(labelOf(updated, "mlx-serve-local", "qwen3-4b")).toEqual({
      contextLabel: "declarado",
      contextSource: "prompt",
    });
    expect(labelOf(updated, "llama-swap-local", "glm-4.5-air")).toEqual({
      contextLabel: "declarado",
      contextSource: "prompt",
    });
  });
});

describe("withLastError — lastError update path (feeds list/prune reporting)", () => {
  it("sets lastError for the matching Provider without touching other servers", () => {
    const updated = withLastError(fullState, "llama-swap-local", "connection refused");

    expect(updated.servers.find((s) => s.providerKey === "llama-swap-local")?.lastError).toBe(
      "connection refused",
    );
    expect(updated.servers.find((s) => s.providerKey === "mlx-serve-local")?.lastError).toBe(
      "timed out after 1000ms",
    );
  });

  it("clears lastError by passing undefined, and does not mutate the original state", () => {
    const updated = withLastError(fullState, "mlx-serve-local", undefined);

    expect(updated.servers.find((s) => s.providerKey === "mlx-serve-local")?.lastError).toBeUndefined();
    expect(fullState.servers.find((s) => s.providerKey === "mlx-serve-local")?.lastError).toBe(
      "timed out after 1000ms",
    );
  });
});
