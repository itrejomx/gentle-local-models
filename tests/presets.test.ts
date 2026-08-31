import { describe, expect, it } from "vitest";
import { kindFromOwnedBy, matchedFamily, provider, thinking, type ServerKind } from "../extensions/local-models/presets.ts";

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

describe("kindFromOwnedBy — Server-kind auto-detect from /v1/models owned_by (v0.1.1 hotfix item 3a)", () => {
  it("maps llama-swap's declared owned_by to the llama-swap kind", () => {
    expect(kindFromOwnedBy("llama-swap")).toBe("llama-swap");
  });

  it("maps mtplx's declared owned_by to the mtplx kind", () => {
    expect(kindFromOwnedBy("mtplx")).toBe("mtplx");
  });

  it("maps mlx-serve's declared owned_by to the mlx-serve kind", () => {
    expect(kindFromOwnedBy("mlx-serve")).toBe("mlx-serve");
  });

  it("maps omlx's declared owned_by to the omlx kind", () => {
    expect(kindFromOwnedBy("omlx")).toBe("omlx");
  });

  it("falls back to generic for an unrecognized owned_by value", () => {
    expect(kindFromOwnedBy("vllm")).toBe("generic");
  });

  it("falls back to generic when owned_by is absent", () => {
    expect(kindFromOwnedBy(undefined)).toBe("generic");
  });

  it("falls back to generic for prototype-polluting owned_by values instead of returning an inherited property (R1-008)", () => {
    expect(kindFromOwnedBy("constructor")).toBe("generic");
    expect(kindFromOwnedBy("__proto__")).toBe("generic");
    expect(kindFromOwnedBy("toString")).toBe("generic");
  });

  it("is case-insensitive and trims surrounding whitespace (R3-023)", () => {
    expect(kindFromOwnedBy("Llama-Swap")).toBe("llama-swap");
    expect(kindFromOwnedBy(" MTPLX ")).toBe("mtplx");
    expect(kindFromOwnedBy("OMLX")).toBe("omlx");
    expect(kindFromOwnedBy("Mlx-Serve")).toBe("mlx-serve");
  });
});

describe("matchedFamily (R3-015)", () => {
  it("returns the matched prefix, distinct from the mapped thinkingFormat for glm*", () => {
    expect(matchedFamily("glm-4.5-air")).toBe("glm");
    expect(thinking("glm-4.5-air", true)).toBe("zai");
  });

  it("returns the same value as the format for qwen*/deepseek* where prefix == format", () => {
    expect(matchedFamily("qwen3-4b")).toBe("qwen");
    expect(matchedFamily("deepseek-r1")).toBe("deepseek");
  });

  it("returns undefined for an unmatched family", () => {
    expect(matchedFamily("llama-3.1-8b")).toBeUndefined();
  });
});

describe("matchedFamily/thinking — token match on any '-'/'_'-delimited segment (fix/family-token-match)", () => {
  it("matches a vendor-prefixed llama-swap id where the family is a middle token, not the leading one", () => {
    expect(matchedFamily("mtplx-qwen38-27b-uncensored-4bit")).toBe("qwen");
    expect(thinking("mtplx-qwen38-27b-uncensored-4bit", true)).toBe("qwen");
  });

  it("still returns undefined when no token starts with a known family prefix", () => {
    expect(matchedFamily("mtplx-ornith15-35b-a3b")).toBeUndefined();
    expect(thinking("mtplx-ornith15-35b-a3b", true)).toBeUndefined();
  });

  it("keeps unchanged behavior for a bare basename match (org/… id, single leading token)", () => {
    expect(matchedFamily("zai-org/glm-4.7-flash")).toBe("glm");
    expect(thinking("zai-org/glm-4.7-flash", true)).toBe("zai");
    expect(matchedFamily("unsloth/qwen3.6-27b")).toBe("qwen");
    expect(thinking("unsloth/qwen3.6-27b", true)).toBe("qwen");
  });

  it("does not match across underscore-joined tokens that merely contain a longer family-unrelated word", () => {
    expect(matchedFamily("Kwaipilot_KAT-Coder-V2.5-Dev-Q8_0")).toBeUndefined();
    expect(thinking("Kwaipilot_KAT-Coder-V2.5-Dev-Q8_0", true)).toBeUndefined();
  });

  it("accepted trade-off: a 'qwen' token anywhere in the id matches, even in a non-qwen finetune name — opt-in via the batched confirm, not silent", () => {
    expect(matchedFamily("not-a-qwen-finetune")).toBe("qwen");
    expect(thinking("not-a-qwen-finetune", true)).toBe("qwen");
  });
});
