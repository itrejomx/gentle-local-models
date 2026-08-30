# Review Ledger — v0.1-registrar

## PR1 bootstrap (`pr1-bootstrap` vs `main`) — R3 reliability, 2026-08-30

Sweep: 1 (standard tier). Verified in a disposable worktree (`npm ci` + `npm test`, exit 0). No BLOCKER/CRITICAL findings; no refutation pass required. Editor diagnostic TS2307 on `vitest.config.ts` REFUTED: `npx tsc --noEmit` exits 0 both as-configured and with the file force-included; LSP artifact.

| id | lens | location | severity | status | evidence |
|---|---|---|---|---|---|
| R3-001 | reliability | tsconfig.json:16 (`include`) | SUGGESTION | info | `include: ["extensions","tests"]` never covers root config files (confirmed via `tsc --listFiles`), so a future `typecheck` CI gate would silently skip `vitest.config.ts`. Harmless today; include root configs when a typecheck script lands. |

## PR2 detect.ts (`pr1-bootstrap...pr2-detect`) — R3 reliability, 2026-08-30

Sweep: 1 (standard tier, ~208 lines). `npm ci` + `tsc --noEmit` (exit 0) + `vitest run` (9/9) verified on the branch. Editor TS2307 on tests/detect.test.ts REFUTED with the real compiler (second LSP-only artifact; see PR1 entry). No BLOCKER/CRITICAL; no refutation pass.

| id | lens | location | severity | status | evidence |
|---|---|---|---|---|---|
| R3-002 | reliability | extensions/local-models/detect.ts:34-44 | WARNING | info | `normalize()` throws uncaught `TypeError: Invalid URL` on empty/invalid input (repro: "", "   ", ":11234", "not a url") — the one entry point for user-typed `/local-models add` input, yet no errors-as-values path and zero invalid-input tests. **Phase 8 acceptance: the shell MUST catch/translate this (or normalize gains a result type) with tests.** |
| R3-003 | reliability | extensions/local-models/detect.ts:70-71 | WARNING | info | Zero-models tolerance only tested for `{data: []}`; `{}` untested; `{data: [{}]}` passes the guard and returns `status: "reachable", models: [undefined]` — a semi-conformant `/v1/models` (plausible for local servers) reported as success with garbage ids. **Phase 8/hardening acceptance: filter entries without string `id`; treat all-invalid as zero models; add tests.** |

## PR3 presets.ts (`pr3-presets`) — R3 reliability, 2026-08-30

Sweep: 1 (standard tier). `vitest run` 24/24 green pre-fix. No other BLOCKER/CRITICAL findings survived refutation.

| id | lens | location | severity | status | evidence |
|---|---|---|---|---|---|
| R3-004 | reliability | extensions/local-models/presets.ts:68 | CRITICAL | fixed | `startsWith` matched against the full lowercased id, so namespaced HuggingFace-style ids (e.g. `zai-org/glm-4.7-flash`, `unsloth/qwen3.6-27b`) never matched their family; refuter verdict STANDS; fixed by matching `startsWith` against the basename after the last `/`. |

## PR4 context.ts (`pr4-context`) — R3 reliability, 2026-08-30

Sweep: 1 (standard tier, R3 lens). `vitest run` 39/41 green pre-fix (2 new RED tests failing as expected). No other BLOCKER/CRITICAL findings survived refutation.

| id | lens | location | severity | status | evidence |
|---|---|---|---|---|---|
| R3-005 | reliability | extensions/local-models/context.ts:81-101 (`parseLlamaSwapCtxSize`) | CRITICAL | fixed | comment lines inside scan window matched by ctx-size regex, first match wins; refuter STANDS noting latent-only exposure today; fixed by skipping comment lines. |
| R3-006 | reliability | extensions/local-models/context.ts (`ContextPorts.readLlamaSwapConfig`) | WARNING | info | ContextPorts.readLlamaSwapConfig has no handling for a rejecting port; Phase 7 shell port implementation must catch fs errors and return undefined — Phase 7 acceptance note. |
