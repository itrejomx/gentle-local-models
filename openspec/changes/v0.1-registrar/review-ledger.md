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

## PR5 state.ts (`pr5-state`) — R3 reliability, 2026-08-30

Sweep: 1 (standard tier, R3 lens). `vitest run` 54/54 green pre-fix. Editor TS7006 diagnostic REFUTED: tsconfig has `strict: true`, `npx tsc --noEmit` exits 0, a third LSP-only artifact (see PR1/PR2 entries for the first two). One CRITICAL finding survived refutation; fixed with a one-line guard.

| id | lens | location | severity | status | evidence |
|---|---|---|---|---|---|
| R3-007 | reliability | extensions/local-models/state.ts:84-87 (`labelOf`) | CRITICAL | fixed | `server?.models[modelId]` — optional chaining guarded `server` but not `.models`, so a parseable state file whose server record lacks `models` (passes the shallow `isValid`) made `labelOf` throw `TypeError`, breaking the module's fail-closed convention (`ownerOf` uses `?? "unknown"`); refuter verdict STANDS, with the severity note that there is no live caller until Phase 7/8; fixed by changing the access to `server?.models?.[modelId]` so `labelOf` returns `undefined` instead of throwing. |
| R3-008 | reliability | tests/state.test.ts | WARNING | info | forward-compat test asserts known fields only and would not catch a refactor dropping unknown keys — strengthen when touching state.ts next. |

## PR6 models-writer.ts review fixes (`pr6-writer`) — Full 4R sweep, 2026-08-30

Sweep: full 4R (models-writer.ts is the one module allowed to mutate a real Pi
config file — `~/.pi/agent/models.json` — under D-001's "never corrupt it" contract,
a data-loss/architecture risk profile matching the hot-path trigger). 4 lenses
(review-risk, review-resilience, review-readability, review-reliability) ran one
sweep each against the pre-fix diff; `npx vitest run` was 79/79 green pre-fix. The
lens ledgers merged into 7 lettered BLOCKER/CRITICAL candidates (A–G); B and F were
independently flagged by different lenses but describe the same underlying defect,
so they carry one merged fix while remaining 2 of the 7 candidates that went through
adversarial verification. 3 refuters (correctness, exploitability/impact,
reproducibility) evaluated the complete merged candidate list; unanimous STANDS
(3/3) on all 7. This round (fix round 1) resolves A, B+F, C, D, G in code/tests; E
is WARNING/info and is documented as a known limitation rather than fixed in code.

| id | lens | location | severity | status | evidence |
|---|---|---|---|---|---|
| A — R1-001, R3-009 | risk, reliability | `extensions/local-models/models-writer.ts` `rotateBackups` (pre-fix) | CRITICAL | fixed | `rotateBackups` computed the backup path from `now()` alone, so two commits landing in the same clock tick (a low-resolution clock, or two rapid `add`s) silently clobbered each other's pre-image backup, defeating R2's rotation guarantee. 3/3 refuters STANDS. Fixed by suffixing `-1`, `-2`, ... via a `readFile`-based existence check until the path is free; the epoch comparator is suffix-aware so rotation/restore ordering still treats a suffixed backup as newer than its unsuffixed sibling. |
| B+F — R1-002, R3-010, R4-004, R2-001 | risk, reliability, resilience, reliability | `extensions/local-models/models-writer.ts` `restoreNewestBackup`, `commit` (pre-fix) | BLOCKER | fixed | The single `restored` `WriteOutcome` variant used a `backup: ""` sentinel to mean "nothing was restored (no backup existed)", conflating that with "a backup was restored" and giving callers no way to distinguish a genuine restore from a rollback-to-no-file, nor whether an unreadable backup silently discarded a failed write. 3/3 refuters STANDS. Fixed by splitting into `restored` (names the backup path, plus a SECOND `verifyWritten` per design D3: restore → refresh again → report) / `rolled-back` (no backup existed) / `restore-failed` (restore itself failed; the failed write is left in place and reported honestly) — no ambiguous sentinel. |
| C — R1-003, R4-002, R3-011 | risk, resilience, reliability | `extensions/local-models/models-writer.ts` `commit` (pre-fix) | CRITICAL | fixed | `commit()` called `ports.readFile`/`writeFile`/`verifyWritten`/the restore path without any wrapping; a rejecting or throwing port implementation threw straight past `commit()`, violating the module's own "no thrown exception can leave models.json half-written" header invariant. 3/3 refuters STANDS. Fixed by wrapping every port-calling stage (read, rotateBackups, main write, verifyWritten, restore) so any rejection resolves to a `WriteOutcome` value; a rejecting main write or a throwing `verifyWritten` now route through the same restore-recovery path instead of crashing, and a throwing restore itself becomes a `write-failed` outcome. |
| D — R4-001, R1-005 | resilience, risk | `WriterPorts.writeFile` contract; `tests/models-writer.integration.test.ts` `realFsPorts` (pre-fix) | BLOCKER | fixed | `WriterPorts.writeFile` carried no atomicity contract, and the integration test's reference `fs` port did a plain `writeFile`, exposing a real partial-content window on crash/interrupt and handing Phase 7's real shell port an unsafe pattern to copy; separately, an `invalid` outcome for a corrupted EXISTING file gave the shell no way to offer recovery. 3/3 refuters STANDS. Fixed by documenting the write-temp+rename atomicity contract on the port, making the reference `fs` port implement it (verified via a mocked `node:fs/promises` `rename` call), and adding a `backups: string[]` field to `invalid` sourced from `listBackups`. |
| E — R4-003, R1-004 | resilience, risk | `extensions/local-models/models-writer.ts` `commit` (single read) | WARNING | info | `commit()` reads `models.json` once and writes back a merge of that snapshot; an external write landing in the read-write window is clobbered and not captured in any backup. Refuters agreed this is a real but narrow, millisecond-scale risk for an interactively-invoked, single-user CLI command — not a fix-now defect. Not fixed in code; documented as a known limitation in `design.md` instead (accepted for v0.1, revisit if a batch/concurrent-writer mode arrives). |
| G — R2-003 | readability | `tests/models-writer.test.ts:323-333` (pre-fix) | CRITICAL | fixed (test-only) | The test titled "surfaces lint warnings for unknown compat keys" fed only already-known compat keys and never asserted `outcome.lint`, so it would still pass even if the lint feature were completely broken — a false sense of coverage on a review-relevant path. 3/3 refuters STANDS (impact note: test-only, no production defect). Fixed by feeding a misspelled Provider-level key and a bogus Model-level key and asserting both are named in `outcome.lint`; production `lint()` already implemented this correctly, so no code change was needed. |
| R2-002 | readability | `extensions/local-models/models-writer.ts` (`JSON.parse` catch vs. schema-validation catch) | SUGGESTION | info | Both branches return `kind: "invalid"`, but one means "not JSON at all" and the other means "valid JSON, wrong shape" — a dual-meaning kind that was untested as two distinct branches prior to this round (both are now exercised by the item-4c `backups` tests). Non-blocking; a future split (e.g. a `reason` discriminant) would sharpen the contract further. |
| R2-004 | readability | `tests/models-writer.test.ts` (maxTokens test title, pre-fix) | SUGGESTION | info | A test titled around the "conservative default" also asserts an explicit override value, so the title reads broader than what it verifies. Cosmetic; left untouched in this surgical round to keep the diff scoped to the 6 assigned items. |
| R3-012 | reliability | `openspec/changes/v0.1-registrar/design.md` Interfaces (`WriterPorts`/`WriteOutcome`, pre-fix) | WARNING | info → fixed (partial, in scope) | `design.md`'s `WriterPorts` was missing `deleteFile` and had `listBackups()` taking no `path` argument, and `WriteOutcome` still showed the pre-PR6 single `restored` variant — drifted from the real code. Resolved as part of items 1/3/4a: `design.md`'s Interfaces block now matches the real `WriterPorts`/`WriteOutcome` shapes, including the `restored`/`rolled-back`/`restore-failed`/`write-failed` kinds, the atomic-write contract note, and `invalid`'s `backups` field. |

Adversarial verification: 3 refuters (correctness, exploitability/impact,
reproducibility) evaluated the complete merged candidate list (A, B, C, D, E, F, G —
7 candidates; B and F share one fix) independently; unanimous STANDS (3/3) on all 7.
No refutations.

Verification after fix round 1: `npx vitest run` 89/89 green; `npx tsc --noEmit`
exits 0.

### PR6 fix-round scoped re-review (2026-08-30) — CONVERGED

All fixed rows verified against the fix diff (45a7f78..342f877); 89/89 green, tsc clean. Round 2 not required. New info rows from fix-touched lines:

| id | lens | location | severity | status | evidence |
|---|---|---|---|---|---|
| R3-013 | reliability | models-writer.ts (`write-failed` variant) | WARNING | info | No test produces or asserts `kind:"write-failed"` (stage/fileState unverified by assertion; logic confirmed by inspection). Cover when Phase 7 wires failure paths. |
| R3-014 | reliability | integration realFsPorts.writeFile / WriterPorts JSDoc | WARNING | info | Reference tmp+rename leaves an orphaned tmp file if rename throws; not cleaned, not documented, and Phase 7 is told to copy this implementation. Add cleanup or document when building the real port. |

## PR7 ui wrappers (`pr6-writer...pr7-ui`) — R3 reliability, 2026-08-30

Sweep: 1 (standard tier, ~267 lines). 102/102 green, tsc clean, no test.only. withLoader finally-restore + rethrow verified; promptWithPrefill matches D5 (hasUI guard, cancel passthrough, no coercion); all five wrappers' signatures cross-checked against Pi's real ExtensionUIContext (types.d.ts:68-192) — all match. **Empty ledger: no findings survived the sweep.**
