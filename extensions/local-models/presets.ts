// Pure core module — no `ctx` import, no Pi runtime dependency.
// Per-Server-kind differences live here as data (R3), never as code branches (D1).

export type ServerKind = "mtplx" | "omlx" | "mlx-serve" | "llama-swap" | "generic";

export interface CompatBlock {
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  maxTokensField: string;
}

export type ThinkingFormat = "qwen" | "zai" | "deepseek";

// Seeded from the one block verified working today (proposal.md D2, verbatim
// from mtplx's own `pi.py`); every known Server kind shares it as a
// conservative default. `CompatBlock` has no `thinkingFormat` field, so it
// can never be set at the Provider level by construction.
const CONSERVATIVE_COMPAT: CompatBlock = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
};

const PRESET_TABLE: Record<ServerKind, CompatBlock> = {
  mtplx: CONSERVATIVE_COMPAT,
  omlx: CONSERVATIVE_COMPAT,
  "mlx-serve": CONSERVATIVE_COMPAT,
  "llama-swap": CONSERVATIVE_COMPAT,
  generic: CONSERVATIVE_COMPAT,
};

/**
 * Returns the Provider-level `compat` block for a given Server kind.
 * Data-driven (R3): Server differences live in this table, not in code
 * branches. Returns a fresh copy so callers cannot mutate the shared preset.
 */
export function provider(kind: ServerKind): CompatBlock {
  return { ...PRESET_TABLE[kind] };
}

const FAMILY_PREFIXES: ReadonlyArray<[prefix: string, format: ThinkingFormat]> = [
  ["qwen", "qwen"],
  ["glm", "zai"],
  ["deepseek", "deepseek"],
];

/**
 * Proposes a model-level `thinkingFormat` by family heuristic
 * (`qwen*` → `qwen`, `glm*` → `zai`, `deepseek*` → `deepseek`, otherwise
 * omitted), and only when `reasoning` is true. An explicit `override` wins
 * over the heuristic, covering the per-model pre-write override requirement.
 * Never applies at the Provider level — see `CompatBlock`.
 */
function matchFamilyPrefix(modelId: string): [prefix: string, format: ThinkingFormat] | undefined {
  const id = modelId.toLowerCase();
  const basename = id.slice(id.lastIndexOf("/") + 1);
  return FAMILY_PREFIXES.find(([prefix]) => basename.startsWith(prefix));
}

export function thinking(
  modelId: string,
  reasoning: boolean,
  override?: ThinkingFormat,
): ThinkingFormat | undefined {
  if (override !== undefined) {
    return override;
  }

  if (!reasoning) {
    return undefined;
  }

  return matchFamilyPrefix(modelId)?.[1];
}

/**
 * Returns the matched family prefix (e.g. "qwen", "glm", "deepseek") for a
 * model id, distinct from its mapped `thinkingFormat` (glm* maps to the
 * "zai" format) — used by the R3-015 reasoning confirm prompt to show a
 * human-readable family name alongside the proposed format.
 */
export function matchedFamily(modelId: string): string | undefined {
  return matchFamilyPrefix(modelId)?.[0];
}

// v0.1.1 hotfix item 3a: maps a Server's /v1/models `owned_by` field to a
// ServerKind for `add`'s kind auto-detect. Data-driven (R3): any owned_by
// value outside this known set — including a missing one — falls back to
// "generic" rather than guessing.
const OWNED_BY_KIND: Readonly<Record<string, ServerKind>> = {
  "llama-swap": "llama-swap",
  mtplx: "mtplx",
  "mlx-serve": "mlx-serve",
  omlx: "omlx",
};

/**
 * Maps a probed Server's `owned_by` value to the ServerKind `add` preselects.
 * Normalized with `toLowerCase().trim()` first (R3-023) so a Server
 * declaring `"Llama-Swap"` or `" MTPLX "` still resolves to its matching
 * kind instead of falling through to "generic" on a case/whitespace
 * mismatch — `OWNED_BY_KIND`'s keys are themselves already lowercase.
 * `Object.hasOwn` guards the lookup (R1-008) so a Server declaring
 * `owned_by: "constructor"` (or `"__proto__"`, `"toString"`, ...) can never
 * resolve to an inherited `Object.prototype` property instead of a genuine
 * table entry — those all correctly fall back to "generic", same as any
 * other unrecognized value.
 */
export function kindFromOwnedBy(ownedBy: string | undefined): ServerKind {
  if (ownedBy === undefined) {
    return "generic";
  }
  const normalized = ownedBy.toLowerCase().trim();
  if (!Object.hasOwn(OWNED_BY_KIND, normalized)) {
    return "generic";
  }
  return OWNED_BY_KIND[normalized];
}
