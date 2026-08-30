import { describe, expect, it, vi } from "vitest";
import { resolve, type ContextPorts, type ContextSources } from "../extensions/local-models/context.ts";

const noPorts: ContextPorts = {
  readLlamaSwapConfig: async () => undefined,
};

describe("resolve — source priority chain (R4)", () => {
  it("resolves from /v1/models max_model_len, labeled verificado", async () => {
    const sources: ContextSources = { vModels: { max_model_len: 8192 } };

    const result = await resolve("qwen3-4b", sources, noPorts);

    expect(result).toEqual({
      kind: "resolved",
      value: 8192,
      label: "verificado",
      source: "v1/models",
    });
  });

  it("resolves from /v1/models context_length when max_model_len is absent", async () => {
    const sources: ContextSources = { vModels: { context_length: 4096 } };

    const result = await resolve("qwen3-4b", sources, noPorts);

    expect(result).toEqual({
      kind: "resolved",
      value: 4096,
      label: "verificado",
      source: "v1/models",
    });
  });

  it("resolves from /v1/models meta.context_length when the top-level fields are absent", async () => {
    const sources: ContextSources = { vModels: { meta: { context_length: 32768 } } };

    const result = await resolve("qwen3-4b", sources, noPorts);

    expect(result).toEqual({
      kind: "resolved",
      value: 32768,
      label: "verificado",
      source: "v1/models",
    });
  });

  it("falls back to /props default_generation_settings.n_ctx when /v1/models has no context fields", async () => {
    const sources: ContextSources = {
      vModels: {},
      props: { default_generation_settings: { n_ctx: 16384 } },
    };

    const result = await resolve("qwen3-4b", sources, noPorts);

    expect(result).toEqual({
      kind: "resolved",
      value: 16384,
      label: "verificado",
      source: "props",
    });
  });

  it("falls back to llama-swap config.yaml --ctx-size when neither /v1/models nor /props resolve", async () => {
    const configText = [
      "models:",
      '  "qwen3-4b":',
      "    cmd: |",
      "      /path/to/llama-server",
      "      --model /models/qwen3.gguf",
      "      --ctx-size 8192",
      '  "glm-4.5-air":',
      "    cmd: llama-server --model /models/glm.gguf --ctx-size 4096",
    ].join("\n");
    const ports: ContextPorts = { readLlamaSwapConfig: async () => configText };

    const result = await resolve("qwen3-4b", {}, ports);

    expect(result).toEqual({
      kind: "resolved",
      value: 8192,
      label: "verificado",
      source: "llama-swap-config",
    });
  });

  it("ignores a decoy --ctx-size inside a mapping-level comment and resolves the real value", async () => {
    const configText = [
      "models:",
      '  "qwen3-4b":',
      "    # old: --ctx-size 4096, bumped after re-measuring",
      "    cmd: llama-server --model /models/qwen3.gguf --ctx-size 8192",
    ].join("\n");
    const ports: ContextPorts = { readLlamaSwapConfig: async () => configText };

    const result = await resolve("qwen3-4b", {}, ports);

    expect(result).toEqual({
      kind: "resolved",
      value: 8192,
      label: "verificado",
      source: "llama-swap-config",
    });
  });

  it("returns unresolved when the only --ctx-size-looking text in the block is inside a comment", async () => {
    const configText = [
      "models:",
      '  "qwen3-4b":',
      "    # --ctx-size 4096",
      "    cmd: llama-server --model /models/qwen3.gguf",
    ].join("\n");
    const ports: ContextPorts = { readLlamaSwapConfig: async () => configText };

    const result = await resolve("qwen3-4b", {}, ports);

    expect(result).toEqual({ kind: "unresolved" });
  });

  it("extracts the ctx-size for the correct model id when the config has multiple models", async () => {
    const configText = [
      "models:",
      '  "qwen3-4b":',
      "    cmd: llama-server --model /models/qwen3.gguf --ctx-size 8192",
      '  "glm-4.5-air":',
      "    cmd: llama-server --model /models/glm.gguf --ctx-size 4096",
    ].join("\n");
    const ports: ContextPorts = { readLlamaSwapConfig: async () => configText };

    const result = await resolve("glm-4.5-air", {}, ports);

    expect(result).toEqual({
      kind: "resolved",
      value: 4096,
      label: "verificado",
      source: "llama-swap-config",
    });
  });

  it("returns unresolved and never prompts when no source resolves", async () => {
    const result = await resolve("qwen3-4b", {}, noPorts);

    expect(result).toEqual({ kind: "unresolved" });
  });

  it("returns unresolved when the llama-swap config has no block for this model id", async () => {
    const configText = ["models:", '  "glm-4.5-air":', "    cmd: llama-server --ctx-size 4096"].join(
      "\n",
    );
    const ports: ContextPorts = { readLlamaSwapConfig: async () => configText };

    const result = await resolve("qwen3-4b", {}, ports);

    expect(result).toEqual({ kind: "unresolved" });
  });

  it("prefers /v1/models over /props and llama-swap config when all are present", async () => {
    const sources: ContextSources = {
      vModels: { max_model_len: 8192 },
      props: { default_generation_settings: { n_ctx: 4096 } },
    };
    const ports: ContextPorts = {
      readLlamaSwapConfig: async () => '  "qwen3-4b":\n    cmd: llama-server --ctx-size 2048',
    };

    const result = await resolve("qwen3-4b", sources, ports);

    expect(result).toEqual({
      kind: "resolved",
      value: 8192,
      label: "verificado",
      source: "v1/models",
    });
  });

  it("prefers /props over llama-swap config when /v1/models is absent", async () => {
    const sources: ContextSources = { props: { default_generation_settings: { n_ctx: 4096 } } };
    const ports: ContextPorts = {
      readLlamaSwapConfig: async () => '  "qwen3-4b":\n    cmd: llama-server --ctx-size 2048',
    };

    const result = await resolve("qwen3-4b", sources, ports);

    expect(result).toEqual({
      kind: "resolved",
      value: 4096,
      label: "verificado",
      source: "props",
    });
  });

  it("does not read the llama-swap config when /v1/models already resolves (short-circuits the chain)", async () => {
    const readLlamaSwapConfig = vi.fn(async () => "unused");
    const sources: ContextSources = { vModels: { max_model_len: 8192 } };

    await resolve("qwen3-4b", sources, { readLlamaSwapConfig });

    expect(readLlamaSwapConfig).not.toHaveBeenCalled();
  });

  it("ignores a Server-reported dynamic memory.max_safe_context in /props: only n_ctx is used", async () => {
    const sources: ContextSources = {
      props: {
        default_generation_settings: { n_ctx: 16384 },
        memory: { max_safe_context: 9000 },
      },
    };

    const result = await resolve("qwen3-4b", sources, noPorts);

    expect(result).toEqual({
      kind: "resolved",
      value: 16384,
      label: "verificado",
      source: "props",
    });
  });
});
