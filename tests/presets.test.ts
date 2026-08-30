import { describe, expect, it } from "vitest";
import { provider, thinking, type ServerKind } from "../extensions/local-models/presets.ts";

describe("provider", () => {
  const kinds: ServerKind[] = ["mtplx", "omlx", "mlx-serve", "llama-swap", "generic"];

  it.each(kinds)("returns the shared conservative compat block for %s", (kind) => {
    expect(provider(kind)).toEqual({
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
    });
  });

  it("never includes a thinkingFormat field at the Provider level", () => {
    const block = provider("llama-swap") as unknown as Record<string, unknown>;
    expect(block.thinkingFormat).toBeUndefined();
  });

  it("returns an independent copy each call so callers cannot mutate the shared preset", () => {
    const first = provider("mtplx");
    first.maxTokensField = "mutated";

    const second = provider("mtplx");

    expect(second.maxTokensField).toBe("max_tokens");
  });
});

describe("thinking", () => {
  it("proposes qwen for a qwen* model with reasoning true", () => {
    expect(thinking("qwen3-4b", true)).toBe("qwen");
  });

  it("proposes zai for a glm* model with reasoning true", () => {
    expect(thinking("glm-4.5-air", true)).toBe("zai");
  });

  it("proposes deepseek for a deepseek* model with reasoning true", () => {
    expect(thinking("deepseek-r1", true)).toBe("deepseek");
  });

  it("omits the proposal for an unmatched family", () => {
    expect(thinking("llama-3.1-8b", true)).toBeUndefined();
  });

  it("omits the proposal when reasoning is false, even for a matched family", () => {
    expect(thinking("qwen3-4b", false)).toBeUndefined();
  });

  it("supports a mixed-family Server: each model keeps its own family match", () => {
    // llama-swap can serve a qwen* and a glm* model on the same Server (R3 scenario).
    expect(thinking("qwen3-4b", true)).toBe("qwen");
    expect(thinking("glm-4.7-flash", true)).toBe("zai");
  });

  it("lets a per-model override win over the heuristic", () => {
    expect(thinking("qwen3-4b", true, "deepseek")).toBe("deepseek");
  });

  it("is case-insensitive when matching family prefixes", () => {
    expect(thinking("QWEN3-4B", true)).toBe("qwen");
  });

  it("matches the family prefix against the basename after the last '/' for namespaced ids", () => {
    expect(thinking("zai-org/glm-4.7-flash", true)).toBe("zai");
    expect(thinking("unsloth/qwen3.6-27b", true)).toBe("qwen");
  });

  it("omits the proposal when only the namespace (not the basename) resembles a family", () => {
    expect(thinking("lmstudio-community/laguna-xs-2.1", true)).toBeUndefined();
  });

  it("does not overmatch a family name appearing mid-id via substring", () => {
    expect(thinking("Kwaipilot_KAT-Coder-V2.5-Dev-Q8_0", true)).toBeUndefined();
  });
});
