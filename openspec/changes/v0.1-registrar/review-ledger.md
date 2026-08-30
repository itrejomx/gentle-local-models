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

## PR8 index.ts `add` wiring (`pr7-ui...pr8-add`) — Full 4R sweep, 2026-08-30

Sweep: full 4R (index.ts is the shell that touches `ctx` and orchestrates the
one module allowed to mutate `~/.pi/agent/models.json`, and this batch also
introduces user-facing prompts/state persistence around it — a hot-path
risk profile matching PR6's precedent). 4 lenses (review-risk,
review-resilience, review-readability, review-reliability) ran one sweep
each against the pre-fix diff; `npx vitest run` was 132/132 green pre-fix.
3 refuters (correctness, exploitability/impact, reproducibility) evaluated
the complete merged candidate list; unanimous STANDS (3/3) on all 6
BLOCKER/CRITICAL candidates. This round (fix round 1) resolves all 6 in
code/tests.

| id | lens | location | severity | status | evidence |
|---|---|---|---|---|---|
| R4-005 | resilience | `extensions/local-models/ports.ts` `realFetchVModels`/`realFetchProps` (pre-fix) | BLOCKER | fixed | Both D-005 context-metadata reads had no timeout, so a half-dead Server could hang `add()` indefinitely on a bare `await`, with no working-indicator feedback either. 3/3 refuters STANDS. Fixed by adding an `AbortController` timeout (`CONTEXT_FETCH_TIMEOUT_MS`, 5s default — named/documented, more lenient than `detect.ts probe()`'s 1s reachability check but still bounded) matching `probe()`'s own pattern, and wrapping both awaits in one `withLoader(ctx.ui, "Reading context metadata from {baseUrl}…", ...)` call in `index.ts`. RED: a never-resolving fetch stub (real timers, overridden low `timeoutMs`) proved both `tests/ports.test.ts`'s direct port tests and `tests/index.add.test.ts`'s `add()`-level integration test genuinely timed out pre-fix. |
| R3-015 | reliability | `extensions/local-models/index.ts` `add` (pre-fix, reasoning/thinkingFormat block) | CRITICAL | fixed | `reasoning: heuristic !== undefined ? true : undefined` set `reasoning: true` unconditionally for any family-matched model — the user only ever got to override the *format*, never to decline reasoning itself. 3/3 refuters STANDS. Fixed with a three-way split: (a) a Server-declared capability (mlx-serve's `/v1/models` "capabilities" including "reasoning", now a `VModelsFields.capabilities?: string[]` field) is verified, not proposed, and skips the confirm; (b) a family-matched but undeclared model gets ONE `toggleSetting` confirm ("Model {id} looks like a {family} reasoning model. Mark reasoning + thinkingFormat {fmt}?", using presets.ts's new `matchedFamily()` to show the family distinctly from its mapped format, e.g. glm→zai) that sets BOTH `reasoning` and `compat.thinkingFormat` on accept and NEITHER on decline; (c) an unmatched model still proposes nothing. Non-interactive runs propose nothing, omit both, and warn once naming every affected model. RED: 2 of 4 new `tests/index.add.test.ts` cases (decline, `!hasUI`) genuinely failed pre-fix (accept and declared-capability cases happened to pass by coincidence against the old always-true code, confirmed by inspection). |
| R3-016 | reliability | `extensions/local-models/index.ts` `add` (pre-fix, ask-at-registration prompt) | CRITICAL | fixed | The prompt answer was only checked for `!== undefined`; an empty string, non-numeric text, or `"0"`/negative all still took the `declarado` branch, writing `contextWindow: 0` or `NaN` silently instead of falling back to the placeholder path. 3/3 refuters STANDS. Fixed by trimming the answer and validating `Number.isFinite(parsed) && parsed > 0`; any rejection (empty/non-numeric/NaN/zero/negative) now takes the exact same placeholder path as cancel, plus a notify naming the rejected input. RED: reverted just this snippet to prove `""` → `contextWindow: 0` and `"0"` → accepted-as-declared, both genuine pre-fix failures against the new tests. |
| R2-006 | readability | `extensions/local-models/index.ts` `renderOutcome` (pre-fix, `write-failed` branch) | CRITICAL | fixed | The generic `write-failed` sentence named only the `fileState` enum value (`"unverified-write"`), giving no actionable recovery path for the one case where a bad write may already be sitting on disk (restore itself threw while recovering) — markedly less actionable than the sibling `restore-failed` message. 3/3 refuters STANDS. Fixed with a `stage:"restore"`/`fileState:"unverified-write"`-specific branch naming `models.json`'s path, the newest backup path when available, and instructing manual inspection/restore explicitly. RED: an assertion requiring the literal phrase "`{path} may be corrupted`" (not just an accidental substring match against the backup filename) failed against the old generic message. |
| R4-006 | resilience | `extensions/local-models/index.ts` `add` (pre-fix, loadState/saveState block) | CRITICAL | fixed | The plugin's own `loadState`/`saveState` calls ran unguarded after a successful `models.json` write; a rejecting/throwing `StatePorts` implementation escaped `add()` as an unhandled rejection, silently losing the "Registered" message's promised context labels/ownership with no error surfaced at all. 3/3 refuters STANDS — impact lens noted this could be scored WARNING in isolation (models.json itself is already correctly written and is the real source of truth), but the orchestrator kept it CRITICAL because the failure mode is a **lying success**: the user sees "Registered" with no indication that bookkeeping silently failed. Location corrected during triage: the ledger's original citation (index.ts:282-292) predates this batch's edits; the actual block is index.ts:242-254 (pre-fix line numbers, before R3-015/R3-016 shifted the file). Fixed by wrapping the block in try/catch and notifying an explicit warning ("Registered in models.json, but plugin bookkeeping failed ({err}): context labels and ownership were not saved. Fix the cause and re-run add.") immediately after the existing success notify — both messages are observed, in order. RED: a rejecting `writeState` produced a genuine unhandled promise rejection pre-fix. |
| R3-017 | test-only | `tests/index.add.test.ts` (re-add / merge coverage gap) | CRITICAL→test-only | fixed (test-only) | No test exercised the `existingIdx >= 0` merge branch (re-registering an already-known Server), so a regression dropping or relabeling prior `ModelLabel` entries on re-add would have gone undetected. 3/3 refuters STANDS on the coverage-gap finding; per the R3-013/G precedent (PR6), inspection confirmed the production merge logic (`{...(existingIdx >= 0 ? state.servers[existingIdx].models : {}), ...labels}`) was already correct — no code change was needed. Fixed by calling `add()` twice against the same Server, feeding the first run's persisted state back in via `fakeStatePorts`'s `initial` param, and asserting the first run's `ModelLabel` survives untouched and the server record is updated in place (not duplicated). |

Adversarial verification: 3 refuters (correctness, exploitability/impact,
reproducibility) evaluated the complete merged candidate list (R4-005,
R3-015, R3-016, R2-006, R4-006, R3-017 — 6 candidates) independently;
unanimous STANDS (3/3) on all 6. No refutations.

Verification after fix round 1: `npx vitest run` 149/149 green (132
pre-fix baseline + 17 new: 2 `tests/ports.test.ts` timeout cases, 1 `add()`
timeout integration case, 3 `matchedFamily` cases, 4 R3-015 reasoning-
confirm cases, 4 R3-016 context-answer-validation cases, 1 R2-006
write-failed-humanization case, 1 R4-006 state-persistence-guard case, 1
R3-017 re-add-merge case); `npx tsc --noEmit` exits 0. Diff vs. the
pre-fix tip (`0c21bf8`): 8 files changed, 469 insertions(+), 37
deletions(-).

Info rows (not fixed, documented instead):

| id | lens | location | severity | status | evidence |
|---|---|---|---|---|---|
| R2-005 | readability | `extensions/local-models/index.ts` `add` (`servingMode` heuristic) | WARNING | info | `servingMode` is derived per-probe as `probeResult.models.length > 1 ? "on-demand" : "single-model"` — a length-based heuristic, not a per-kind contract, persisted into `gentle-local-models.json` as if it were fact. This is apply-progress's already-documented assumption 2 (batch 8); the surgical round did not touch this code path, so no comment was added per the "only if a fix above already touches that area" instruction. Document as a known heuristic in Phase 9's docs pass. |
| R3-018 | reliability | `extensions/local-models/index.ts` `add` (`servingMode` heuristic, same code as R2-005) | WARNING | info | Same underlying heuristic flagged from the reliability lens: an observed-model-count proxy for a Server's actual serving architecture can misclassify a multi-model-capable Server that happens to report one model at probe time. Left untouched for the same reason as R2-005 — not touched by any of this round's 6 fixes. Document in Phase 9. |

**R1 (risk lens) empty ledger**: no BLOCKER/CRITICAL/WARNING findings from
the risk lens this sweep — the risk-relevant surface (state persistence
honesty, reasoning/thinkingFormat consent, recovery messaging) is fully
covered by R4-006/R3-015/R2-006 above from the resilience/reliability/
readability lenses instead.

**Phase 9 note (llama-swap config path)**: `realContextPorts()`'s default
`readLlamaSwapConfig` path is `~/.llama-swap/config.yaml`, overridable via
`LLAMA_SWAP_CONFIG_PATH` (`extensions/local-models/ports.ts`). This is a
v0.1 placeholder convention (no live discovery of a running llama-swap
instance's own config path — that's R5/v0.2 territory per spec's scope
header), not llama-swap's own default install location. A real user's
config commonly lives elsewhere (e.g. wherever they pass `--config` on
their own launch command); Phase 9's docs (`extensions/local-models/
README.md`, `tests/MANUAL-E2E.md`) MUST call this out explicitly so users
don't assume the plugin auto-discovers their actual file.

### PR8 fix-round scoped re-review (2026-08-30) — CONVERGED

All six fixed rows verified against 0c21bf8..04b8a99; 149/149 green, tsc clean. Editor TS2554/TS2353 REFUTED with tsc --listFiles (4th stale-LSP artifact). Round 2 not required. New info rows:

| id | lens | location | severity | status | evidence |
|---|---|---|---|---|---|
| R3-019 | reliability | index.ts declaredReasoning check | WARNING | info | A Server declaring capabilities WITHOUT "reasoning" falls through to the family confirm (capabilities is an additive positive signal, not exhaustive). Defensible; document if capabilities semantics are formalized. |
| R3-020 | reliability | tests/index.add.test.ts:340-351 | WARNING | info | Test title claims negative-value coverage but only feeds "0"; logic correct by inspection (parsed > 0). Add "-5" case next time the file is touched. |
