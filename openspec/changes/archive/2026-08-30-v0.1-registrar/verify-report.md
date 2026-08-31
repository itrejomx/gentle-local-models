# Verification Report — v0.1 Registrar (R1–R4)

**Change**: v0.1-registrar
**Branch verified**: `pr10-docs` (tip `a0a0351`, clean working tree) — tip of the 10-PR stacked-to-main chain
**Mode**: Strict TDD
**Verdict**: **PASS WITH NOTES** — 0 CRITICAL, 7 WARNING, 4 SUGGESTION

---

## Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 28 |
| Tasks complete | 28 |
| Tasks incomplete | 0 |
| Spec requirements | 21 (across 5 capabilities) |
| Spec scenarios | 24 |
| Requirements SATISFIED | 19 |
| Requirements PARTIAL | 2 |
| Requirements UNSATISFIED | 0 |

Task checkboxes were **not** taken at face value; every phase was cross-checked against the implementing symbol and its covering test (matrix below). All 28 map to real code.

---

## Build & Test Execution (run fresh on `pr10-docs`)

**`npm ci`**: exit 0
```text
added 186 packages, and audited 187 packages in 3s
found 0 vulnerabilities
```

**`npx vitest run`**: exit 0
```text
 Test Files  12 passed (12)
      Tests  175 passed (175)
   Duration  525ms
```

**`npx tsc --noEmit`**: exit 0, no output.

All three match the apply-progress claims exactly (175/175, tsc clean).

### Test distribution

| File | Tests |
|------|-------|
| `tests/index.add.test.ts` | 37 |
| `tests/models-writer.test.ts` | 34 |
| `tests/presets.test.ts` | 21 |
| `tests/context.test.ts` | 14 |
| `tests/detect.test.ts` | 14 |
| `tests/state.test.ts` | 14 |
| `tests/ui.test.ts` | 13 |
| `tests/index.prune.test.ts` | 11 |
| `tests/index.list.test.ts` | 8 |
| `tests/models-writer.integration.test.ts` | 6 |
| `tests/ports.test.ts` | 2 |
| `tests/smoke.test.ts` | 1 |
| **Total** | **175** |

| Layer | Tests | Files |
|-------|-------|-------|
| Unit (stubbed ports, pure core + shell against fakes) | 169 | 11 |
| Integration (real `fs` under `os.tmpdir()`) | 6 | 1 |
| E2E | 0 (documented manual checklist: `tests/MANUAL-E2E.md`) | — |

**Coverage**: ➖ Not available — no coverage tool configured in `package.json`/`vitest.config.ts`. Not a failure.

---

## Spec Compliance Matrix — 21 requirements

### Capability: server-registration (R1)

| # | Requirement | Implementation | Covering tests | Verdict |
|---|---|---|---|---|
| 1 | Register and list Servers by URL | `index.ts:add()` / `index.ts:list()`, wired via `index.ts:localModelsExtension` → `pi.registerCommand("local-models")` (`index.ts:603-635`) | `index.add.test.ts` (37), `index.list.test.ts` "lists a Provider known only from models.json and a Server known only from plugin state" | ✅ SATISFIED |
| 2 | URL normalization (`host:port`, `/v1`, `/v1/`) | `detect.ts:normalize()` (`detect.ts:48-58`) | `detect.test.ts` × 3: bare `host:port`, `/v1`, `/v1/` all → same base URL | ✅ SATISFIED |
| 3 | Reachability probe, ≤1 s timeout, no port scan | `detect.ts:probe()` (`DEFAULT_TIMEOUT_MS = 1000`, `AbortController`, `detect.ts:71-104`); `detect.ts:probeAll()` | `detect.test.ts` "aborts and reports unreachable when the Server does not respond within the timeout" (51 ms); "reports unreachable with the last error when the Server rejects"; "probes every given base URL independently". No port-enumeration code exists anywhere. | ⚠️ **PARTIAL** — see W-02 |
| 4 | Warn on omlx/mtplx-rewritten Provider keys | `index.ts:REWRITTEN_PROVIDER_KEYS` (`index.ts:43-46`) + warn at `index.ts:175-178`, emitted **during** `add`, before any write | `index.add.test.ts` "warns immediately that omlx will rewrite this Provider key", "…mtplx…", "does not warn about a rewrite for mlx-serve" | ✅ SATISFIED |

**Scenario detail for #3.** "Unreachable Server reported with last error" → ✅ COMPLIANT. "Zero-models response is a failure" → ⚠️ PARTIAL: `probe()` returns a *third* status `empty` (`detect.ts:27-31`), distinct from both `reachable` and `unreachable`. `add()` rejects it (`index.ts:156-163` — spec-compliant: not registerable). But `list()` renders it as `"reachable, N model(s)"` at `info` severity and **clears** `lastError` (`index.ts:431-439`), and `prune()` treats it as the Server authoritatively reporting none, making **every** registered model of that Provider an Unserved candidate. Deliberate and ledger-documented (R1-006/R3-021), but it contradicts the literal spec scenario.

### Capability: models-json-writer (R2)

| # | Requirement | Implementation | Covering tests | Verdict |
|---|---|---|---|---|
| 5 | Fill-never-overwrite merge | `models-writer.ts:mergeProvider()` (`:222-268`), `fillModel()` (`:175`), `createModel()` (`:196`, `name = id`) | `models-writer.test.ts` × 7 incl. "preserves an existing contextWindow and fills a missing maxTokens with a conservative default" and the realistic 17-model hand-curated `lmstudio` fixture | ✅ SATISFIED |
| 6 | Unserved Models preserved; prune explicit | `mergeProvider()` never deletes; removal only via `models-writer.ts:removeModels()` (`:270`) reached solely from `commitPrune()` | `models-writer.test.ts` "keeps a Model no longer reported by its Server as an Unserved Model (not removed)" | ✅ SATISFIED |
| 7 | Prune any local Provider, show ownership, one confirmation | `index.ts:prune()` (`:493-567`): `listProviders(raw).filter(isLocalHost)` (`:497`), `ownerOf()` per row (`:531`), exactly one `ctx.ui.confirm` outside the loop (`:547`), backup via `commitPrune` | `index.prune.test.ts` × 11 incl. "prunes an Unserved Model from a hand-curated (external) Provider the plugin never wrote", "shows ownership per row … still with one confirmation", "writes a backup before removing anything" | ✅ SATISFIED |
| 8 | Rotating backups, cap 10, only for plugin writes | `models-writer.ts:rotateBackups()` (`:440-463`), `cap = 10`, same-tick suffix collision guard (`:447-452`) | `models-writer.test.ts` × 3 (11th prunes oldest; same-tick suffixing; suffixed backups count toward cap) + `models-writer.integration.test.ts` "caps rotating backups at 10 real files on disk" | ✅ SATISFIED |
| 9 | Pre-write validation against mirrored schema | `models-writer.ts:validate()` (`:367-373`), TypeBox `validator.Check`/`.Errors` | `models-writer.test.ts` × 4 incl. "blocks a merge result with a Model missing its required id"; `commit` test "blocks the write … leaving the file untouched" | ✅ SATISFIED |
| 10 | Read-back after write with auto-restore | `commit()` restore path (`:518+`), `WriterPorts.verifyWritten`; real impl `index.ts:realVerifyWritten()` (`:569-585`) via `ctx.modelRegistry.refresh/getError/find` (D3) | `models-writer.test.ts` "auto-restores the newest backup when verifyWritten reports an empty Provider map", "re-verifies after a successful restore … calls verifyWritten twice" + integration "auto-restores the newest on-disk backup when verifyWritten fails" | ✅ SATISFIED |
| 11 | Refuse to write files containing comments | `models-writer.ts:hasComments()` (`:144-173`, string-aware scanner) → `commit` returns `{kind:"refused", reason:"comments"}`; user-facing reason at `index.ts:90` | `models-writer.test.ts` × 4 incl. "returns false for clean JSON, including URLs with // inside string values" and "refuses and reports when the existing file contains comments" | ✅ SATISFIED |
| 12 | Compat-key lint, warn without blocking | `models-writer.ts:lint()` (`:388-404`) + `warnUnknownKeys()` (`:375`); warnings ride along on `{kind:"written"}` and surface at `index.ts:329-331` | `models-writer.test.ts` × 3 incl. "warns on an unrecognized Model-level compat key without blocking the write"; `index.add.test.ts` "written: notifies success and surfaces lint warnings" | ✅ SATISFIED |

### Capability: compat-presets (R3)

| # | Requirement | Implementation | Covering tests | Verdict |
|---|---|---|---|---|
| 13 | Preset table covering 5 kinds, applied at registration | `presets.ts:PRESET_TABLE` (`:24-30`, all 5 kinds) + `presets.ts:provider()` (`:37-39`, returns a fresh copy); applied at `index.ts:308` | `presets.test.ts` × 7 (one per kind + "never includes a thinkingFormat field at the Provider level" + independent-copy) ; `index.add.test.ts` per-kind extras tests | ✅ SATISFIED (see W-05) |
| 14 | Model-level `thinkingFormat` by family heuristic; never Provider-level | `presets.ts:thinking()` (`:60-74`) + `matchFamilyPrefix()` (`:54-58`, basename-scoped `startsWith`); `CompatBlock` has no `thinkingFormat` field **by construction** (`:6-10`) | `presets.test.ts` × 9 incl. "supports a mixed-family Server: each model keeps its own family match", "does not overmatch a family name appearing mid-id via substring", "matches the family prefix against the basename after the last '/'" | ✅ SATISFIED |
| 15 | Per-model override before write | `presets.ts:thinking(…, override)` (`:65-67`) + shell override prompt `index.ts:263-266` / `:279-282` (`editSetting`), always before `commit()` at `:318` | `presets.test.ts` "lets a per-model override win over the heuristic"; `index.add.test.ts` "proposes the family heuristic and lets the user override it before write", "keeps the heuristic proposal when the override editor is cancelled" | ✅ SATISFIED (see S-01) |

### Capability: context-resolution (R4)

| # | Requirement | Implementation | Covering tests | Verdict |
|---|---|---|---|---|
| 16 | Source priority chain (1→2→3) all labeled `verificado` | `context.ts:resolve()` (`:132-153`); `fromVModels()` (`:49`, `max_model_len` → `context_length` → `meta.context_length`), `fromProps()` (`:65`, `n_ctx`), `parseLlamaSwapCtxSize()` (`:80-114`, block-scoped, comment-skipping) | `context.test.ts` × 12 incl. "resolves from /v1/models max_model_len, labeled verificado", "falls back to llama-swap config.yaml --ctx-size", "prefers /v1/models over /props and llama-swap config", "does not read the llama-swap config when /v1/models already resolves" | ✅ SATISFIED |
| 17 | Ask-at-registration prompt, prefill `32768`, → `declarado` | `index.ts:220` `promptWithPrefill(ctx, …, "32768")` → `ui/prompt.ts` (`ctx.ui.editor`, D5); label set at `index.ts:230`; validation at `:225-241` | `index.add.test.ts` "accepts the pre-filled 32768 and labels it declarado" + 4 R3-016 validation cases (`""`, `"abc"`, `"0"`/negative, whitespace-trimmed `" 65536 "`); `ui.test.ts` "calls ctx.ui.editor with the prefill" | ✅ SATISFIED |
| 18 | Non-interactive fallback omits `contextWindow`, labels `placeholder`, warns | `index.ts:231-241` (same path as cancel) + warning naming every affected model at `:332-334`; registration still proceeds | `index.add.test.ts` "omits contextWindow, labels placeholder, and warns by name when the editor is cancelled", "takes the same omit+placeholder+warning path without opening a dialog when ctx.hasUI is false"; `ui.test.ts` "skips the dialog entirely … when ctx.hasUI is false" | ✅ SATISFIED |
| 19 | Dynamic max-safe-context never overwrites | `context.ts:fromProps()` reads **only** `default_generation_settings.n_ctx`; `memory.max_safe_context` is typed (`:26`) but never read. Re-add guard: `index.ts:211` skips `resolveContext` entirely when `contextWindow` exists (D-005), and `mergeProvider` is fill-never-overwrite | `context.test.ts` "ignores a Server-reported dynamic memory.max_safe_context in /props: only n_ctx is used"; `index.add.test.ts` "never calls context.resolve's sources for a model that already has a recorded contextWindow" | ✅ SATISFIED |

### Capability: plugin-state

| # | Requirement | Implementation | Covering tests | Verdict |
|---|---|---|---|---|
| 20 | State file scope and content (servers, ownership, labels, **piVersion**) | `state.ts:PluginState` (`:29-33`), `load`/`save` (`:58`,`:74`), `ownerOf` (`:79`), `labelOf`/`withLabel` (`:84`,`:90`), `withLastError` (`:107`); written to `~/.pi/agent/gentle-local-models.json` via `ports.ts:stateJsonPath()` | `state.test.ts` × 14 incl. "round-trips a full PluginState including owner, lastError, and per-model context labels"; `index.add.test.ts` "saves a new plugin-owned ServerRecord with baseUrl/kind/servingMode/providerKey" | ⚠️ **PARTIAL** — see W-01 |
| 21 | ADR-0001 boundary — never write gentle-pi's files | Enforced by construction: `ports.ts` is the **only** file importing `node:fs/promises`; paths hardcoded in `modelsJsonPath()` (`:16`) / `stateJsonPath()` (`:20`) | Independent re-audit below; `models-writer.integration.test.ts` operates entirely under `os.tmpdir()` | ✅ SATISFIED |

**Compliance summary**: 22/24 scenarios COMPLIANT, 2 PARTIAL (R1 zero-models rendering in `list`/`prune`; plugin-state `piVersion`). 0 UNTESTED, 0 FAILING.

---

## Boundary Re-Audit (independent of batch 10's own audit)

Re-derived from scratch on `pr10-docs`, not reused from apply-progress:

1. `rg -n 'from "node:' extensions --type ts` → **3 hits, all in `ports.ts`** (`node:fs/promises`, `node:path`, `node:os`). No other production file imports any Node builtin.
2. Every mutating call in `extensions/`: `ports.ts:62` `fsWriteFile(tmpPath)`, `:64` `rename(tmpPath, path)`, `:67` `unlink(tmpPath)` (cleanup), `:75` `unlink(path)` (`deleteFile`), `:109` `fsWriteFile(path)` (`writeState`). `models-writer.ts` writes only through the injected `ports.writeFile` (`:453`, `:490`, `:571`, `:675`); `state.ts` only through `ports.writeState` (`:75`).
3. Sole call site of the real port constructors — `index.ts:buildCommandPorts` (`:587-601`): `writer.path = modelsJsonPath()`, `state = realStatePorts(stateJsonPath())`. Both builders are `join(homedir(), ".pi", "agent", …)` with no parameterization. `realWriterPorts` takes no path argument at all — it can only ever write to whatever `path` `commit`/`commitPrune` passes, which is `writerPath`.
4. Backup paths are always `` `${path}.${epoch}[-${suffix}].bak` `` (`models-writer.ts:447/451`) — siblings of `path`, never independent. Deletion is scoped: `deleteFile` is only ever called on entries from `listBackups(path)`, which filters `entry.startsWith(base + ".") && entry.endsWith(".bak")` (`ports.ts:82`).
5. `rg 'gentle-ai|models.export|subagents' extensions/` → **zero hits**.

**Result: PASS.** Writable surface is exactly `~/.pi/agent/models.json`, its `.tmp-<pid>-<n>` atomic-write scratch siblings, its `.{epoch}[-{suffix}].bak` rotating siblings (cap 10), and `~/.pi/agent/gentle-local-models.json`. Zero write paths reach `~/.pi/gentle-ai/models.json`, `models.export.json`, or `subagents.json`. Independently confirms batch 10's finding.

---

## TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD evidence reported | ✅ | apply-progress records per-phase RED/GREEN per module |
| All tasks have tests | ✅ | 28/28; every phase maps to a named test file |
| RED confirmed (test files exist) | ✅ | 12/12 test files present |
| GREEN confirmed (tests pass now) | ✅ | 175/175 pass on a fresh `npm ci` |
| Triangulation adequate | ✅ | Multi-case per behavior throughout (e.g. `presets.thinking` 9 cases, R3-016 prompt validation 4 cases, backup rotation 3 cases) |
| RED-precedes-GREEN independently provable | ⚠️ | See W-07 — squashed commits |

**Strict-TDD spot-check (3 sampled modules, per instruction — history not re-derived wholesale):**

| Commit | Module | Impl lines | Test lines | Co-located? |
|---|---|---|---|---|
| `128dd36` `feat(detect)` | `detect.ts` | +96 | `tests/detect.test.ts` +110 | ✅ same commit |
| `3c17241` `feat(context)` | `context.ts` | +143 | `tests/context.test.ts` +185 | ✅ same commit |
| `9144cd0` `feat(writer)` | `models-writer.ts` | +378 | `models-writer.test.ts` +344, `.integration.test.ts` +120 | ✅ same commit |

In all three, tests ship with (and out-line) the implementation — consistent with the apply-progress TDD claims. Subsequent `fix(...)` commits each pair a behavioral fix with its regression test, matching the ledger's fix rounds.

### Assertion Quality Audit (Step 5f — mandatory)

Scanned all 12 test files for banned patterns:

- Tautologies (`expect(true).toBe(true)` etc.): **0**
- Assertions with no production-code call: **0**
- Ghost loops (assertions inside a possibly-empty loop): **0**
- Smoke-test-only: **0** — `smoke.test.ts` is the intentional D8 bootstrap gate, not a behavioral claim
- Mock-heavy (mocks > 2× assertions): **0** — the codebase injects ports rather than `vi.mock`-ing modules; the single `vi.mock` (integration test, `node:fs/promises`) wraps rather than replaces the real module
- Type-only assertion used alone: **0** — the one `toBeDefined()` (`models-writer.integration.test.ts:153`) is combined with value assertions at `:154`, `:157`, `:161`
- Empty-collection without companion non-empty test: **1** — `ports.test.ts:30` `expect(result).toEqual({})` (see W-04). All other empty assertions are legitimate negative side-effect proofs (`state.test.ts:71/80` prove `load()` never writes; `index.add.test.ts:141/574/587` prove no write on the reject path), each with positive companions.

**Assertion quality**: 0 CRITICAL, 1 WARNING.

### Quality Metrics

- **Type checker**: ✅ `npx tsc --noEmit` exit 0, zero errors.
- **Linter**: ➖ none configured.
- **Coverage**: ➖ none configured.

---

## Design Coherence

| Decision | Followed? | Notes |
|---|---|---|
| D1 — shell/core split, ports injected, `ctx` never in core | ⚠️ Mostly | `ctx` confined to `index.ts`; all 5 core modules are `ctx`-free and Pi-runtime-free. **But** D1's "per-Server differences live in `presets.ts` data, never in code branches" is violated at `index.ts:311-316` (W-05). |
| D2 — mirrored schema in TypeBox, permissive, lint not block | ✅ | `validate()` + `lint()` split exactly as designed |
| D3 — read-back through Pi's own loader | ✅ | `realVerifyWritten` uses `refresh`/`getError`/`find`; stubbed as a port in tests |
| D4 — ownership in plugin state, never in `models.json` | ✅ | `state.providers[].owner`; no ownership field written to `models.json` |
| D5 — prefilled prompt uses `ctx.ui.editor`, not `ui.input` | ✅ | `ui/prompt.ts`; asserted by `ui.test.ts` "D5: ctx.ui.editor, never ctx.ui.input" |
| D6 — errors are values; 7 `WriteOutcome` kinds | ✅ | All 7 kinds implemented and rendered distinctly (`index.ts:85-137`); 6/7 asserted end-to-end (W-06) |
| D7 — package layout, jiti, no build step | ✅ | `.ts` relative imports with explicit extension; no `dist/`; README documents the symlink + `/reload` loop |
| D8 — bootstrap order (strict-TDD gate) | ✅ | `49a04ee` bootstrap precedes every module commit |
| D-005 — `context.resolve` only for models missing `contextWindow` | ✅ | `index.ts:211` guard + covering test |
| Known limitation: single-read stale window in `commit()` | ✅ Documented | design.md "Known limitations"; unchanged, still accurate |

---

## Issues Found

### CRITICAL
**None.** Nothing blocks archive.

### WARNING

- **W-01 — `piVersion` is never populated (REQ-20 PARTIAL).** The spec requires persisting "the Pi version the mirrored schema was validated against". The field exists (`state.ts:31`) and round-trips, but `freshState()` (`state.ts:41`) initialises it to `""` and **no code anywhere ever writes a real version** — `add()` spreads it through unchanged (`index.ts:355`). `rg piVersion` finds it only in the type, `freshState`, and test fixtures. Design D-002 calls it the "mirror-drift flag"; that flag is inert. Consequence: a v0.2 Check cannot tell which Pi version the mirror was validated against.
- **W-02 — Zero-models handling contradicts the R1 spec scenario in `list`/`prune`.** Spec: "GIVEN a Server that responds 200 with an empty model list, WHEN probed, THEN it is treated as a failure, not a success." `probe()` introduces a third `empty` status; `add()` correctly rejects it, but `list()` reports `"reachable, 0 model(s)"` at `info` and clears `lastError` (`index.ts:431-439`), and `prune()` treats it as an authoritative "reports none" — making **every** registered model of that Provider an Unserved candidate (`index.prune.test.ts` "treats a 200-with-zero-models response as the Server legitimately reporting none"). The reasoning (R1-006/R3-021) is sound for `prune`'s down-Server case, but the empty-response case now points the other way: an idle on-demand Server returning `data: []` would offer to prune its whole model list. Mitigated by the single mandatory confirmation and the ownership-labelled summary. **Either the spec text or `list`/`prune` should be reconciled during archive.**
- **W-03 — The production write ports have zero test coverage, and have now drifted from their tested reference.** Only `realFetchVModels`/`realFetchProps` are ever imported by a test. `realWriterPorts`, `realStatePorts`, `realContextPorts`, `modelsJsonPath`, `stateJsonPath` are untested. `models-writer.integration.test.ts` exercises its own local `realFsPorts` (`:23-60`), a parallel implementation — and the two have **already diverged**: production `writeFile` (`ports.ts:60-73`) has the R3-014 tmp-cleanup-on-rename-failure path; the test's reference (`:39-43`) does not. This is precisely the drift R3-014 predicted, and it means `ports.ts` — the single file that owns the entire ADR-0001 write boundary — is the least-tested file in the change.
- **W-04 — `realFetchVModels`'s parsing path is untested.** `ports.test.ts` has only 2 tests, both timeouts. The id filtering, `meta.context_length` extraction, and `capabilities` filtering (`ports.ts:156-177`) are never exercised, yet they feed two spec paths: R4 source (1) and the R3-015 `declaredReasoning` branch (`index.ts:254`). `index.add.test.ts` uses fake `fetchVModels` ports, so the real parser is never run. Also the sole assertion-quality flag: `ports.test.ts:30` `toEqual({})` has no companion non-empty case.
- **W-05 — Design deviation (D1/R3): per-kind differences as code branches.** `index.ts:311-316` sets mtplx `headers` and omlx `authHeader` via `if (kind === …)`, while design.md D1 states "Per-Server differences live in `presets.ts` data, never in code branches" and R3 requires a "data-driven preset table". Behaviour is correct and tested; the placement contradicts the stated architecture and is the natural spot for drift as kinds are added.
- **W-06 — R3-013 only half-closed.** The shell's *rendering* of `write-failed` is asserted (`index.add.test.ts:628`, `:658`), but no test asserts that `commit()`/`commitPrune()` ever *produces* `kind:"write-failed"`. `models-writer.test.ts` asserts only `restored`(4), `invalid`(2), `rolled-back`(1), `restore-failed`(1), `refused`(1) — 6 of 7 outcome kinds. The producer side of the 7th remains inspection-only.
- **W-07 — RED-before-GREEN is not independently provable.** Each module landed as one squashed `feat(...)` commit containing both test and implementation, so the RED step is not preserved in history. The available evidence (tests co-located and out-lining implementation in all 3 sampled modules; every `fix(...)` paired with a regression test) is *consistent with* the apply-progress TDD claims but does not prove ordering. Not a violation — a verifiability limit.

### SUGGESTION

- **S-01 — `thinkingFormat` override reach is narrower than REQ-15's wording.** The override editor only opens when the family heuristic matched (`index.ts:262`, `:279`). A model with Server-declared `reasoning` but an unmatched family gets no `thinkingFormat` and no chance to supply one. The requirement's scenario is fully satisfied; only its "for any model" phrasing is broader.
- **S-02 — `realVerifyWritten` (`index.ts:569-585`) is untested** — it needs a real `ctx.modelRegistry`. D3's read-back guarantee is proven only through the stubbed `verifyWritten` port. Covered by `tests/MANUAL-E2E.md` §4.
- **S-03 — R3-014 is carried as an open debt but appears actually fixed in production.** `ports.ts:63-72` implements the cleanup with an explicit `R3-014` comment. Only the integration test's reference copy still lacks it (that is W-03). Reconcile the ledger row.
- **S-04 — No coverage tooling.** Changed-file coverage could not be measured. Adding `@vitest/coverage-v8` would let v0.2 quantify the `ports.ts` gap in W-03/W-04.

---

## Accepted Debts — carry-forward list for v0.2

Compiled from the ledger's `info` rows (0 rows remain `open`; 20 `fixed`, 18 `info`). None blocks archive.

| ID | Area | Debt | Note from this verify |
|---|---|---|---|
| R3-022 | `index.ts:list()` dedup | Dedupes by raw `baseUrl` string, not `normalize()`-equality — the same Server in two forms is probed and rendered twice | Confirmed present (`index.ts:398-408`) |
| R4-008 | `index.ts:list()`/`prune()` pre-read | `readFile` at `:395` and `:494` is unguarded — a *rejecting* port escapes as an unhandled rejection | Confirmed present; narrower than the fixed R4-006/R4-007 |
| R1-007 | `commitPrune` branch coverage | Partially closed (3 tests added). `refused`, malformed-JSON `invalid`, and the `write-failed`/`restored`/`rolled-back`/`restore-failed` recovery paths still have no `commitPrune`-specific test | Confirmed: only `commit()`'s equivalents are covered |
| R2-005 / R3-018 | `servingMode` heuristic | `probeResult.models.length > 1 ? "on-demand" : "single-model"` (`index.ts:345`) persisted as if fact | Documented in README per Phase 9 ✅; heuristic unchanged |
| R3-019 | `capabilities` semantics | A Server declaring `capabilities` *without* `"reasoning"` falls through to the family confirm — additive positive signal, not exhaustive | Documented in README ✅ |
| R3-020 | `index.add.test.ts` negative-value case | Title claims negative coverage; only `"0"` is fed. Logic correct by inspection (`parsed > 0`) | Confirmed still the case |
| R3-013 | `write-failed` production coverage | No test asserts `commit`/`commitPrune` *emits* `write-failed` | Now partially closed at the shell-rendering layer (W-06) |
| R3-014 | tmp cleanup on rename failure | Production port fixed; integration-test reference copy still lacks it | Reclassify — see S-03 / W-03 |
| R2-002 | `models-writer.ts` dual-meaning `invalid` | "not JSON at all" vs "valid JSON, wrong shape" share one kind; a `reason` discriminant would sharpen it | Unchanged |
| R2-004 | `models-writer.test.ts` maxTokens test title | Title reads broader than what it verifies | Cosmetic |
| **New (this verify)** | `piVersion` never populated | W-01 — spec-relevant; strongest candidate to fix in v0.2 alongside the Check | — |
| **New (this verify)** | `ports.ts` untested + reference drift | W-03/W-04 — highest-leverage test gap | — |
| Design (pre-existing) | Single-read stale window in `commit()` | Documented in design.md "Known limitations"; accepted for a single-user interactive CLI | Unchanged |
| Design (pre-existing) | `prune` local-Provider scope is hostname-based | LAN-hostname Servers excluded; documented in README and design.md Open Questions | Unchanged |

---

## Governance Note — post-apply judgment-day trigger

The Agent Trigger Rules require `judgment-day` after the apply phase. That trigger was **deliberately satisfied by the per-PR full-4R + 3-refuter protocol** applied across the chain (PR2–PR9), which is strictly stronger than judgment-day's two-blind-judge convergence: four independent review lenses per slice, with a 3-refuter adversarial vote (2-of-3 to refute) on every BLOCKER/CRITICAL candidate, plus scoped re-review to convergence. Evidence: `review-ledger.md` records 20 `fixed` and 18 `info` rows with 0 remaining `open`, including 12 CRITICAL and 3 BLOCKER findings resolved and re-verified. This is an **orchestrator decision, recorded here to close the trigger** — no separate judgment-day pass is required before archive.

---

## Verdict

**PASS WITH NOTES.**

All 28 tasks are genuinely complete, all 21 spec requirements are implemented with real covering tests, the full suite is green on a clean install (175/175), the type check is clean, and the ADR-0001 write boundary holds under an independent re-audit. Two requirements are PARTIAL — `piVersion` is persisted but never populated (W-01), and the zero-models scenario is handled contrary to the literal spec text in `list`/`prune` (W-02). Neither is a correctness or safety defect: both are documented, deliberate, and confined to non-destructive paths guarded by user confirmation. The most substantive engineering gap is that `ports.ts`, which owns the entire write boundary, is untested and has already drifted from its tested reference implementation (W-03).

**Ready for `sdd-archive`**, with the recommendation to reconcile the R1 zero-models spec text and carry W-01/W-03/W-04 into v0.2's scope.
