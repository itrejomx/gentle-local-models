# Tasks: v0.1 Registrar (R1–R4)

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~2900–3300 (bootstrap ~100, 5 core modules ~600, ui ~120, shell ~350, tests ~1900, docs ~80) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR1 → PR10 (Work Units below) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No — resolved by orchestrator (stacked-to-main)
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Greenfield package + 5 pure core modules + shell + UI wrappers, each with paired RED/GREEN vitest files, exceeds 400 authored lines quickly. Chain strategy (stacked-to-main vs feature-branch-chain) is not yet chosen — orchestrator must collect it from the user before PR1's base branch is created; each unit below stays ≤~350 changed lines under either strategy.

### Suggested Work Units

| Unit | Goal | PR | Depends |
|---|---|---|---|
| 1 | Bootstrap: git, package.json, tsconfig, vitest, smoke red→green | PR1 | — |
| 2 | detect.ts: normalize + probe (R1) | PR2 | PR1 |
| 3 | presets.ts: preset table + thinkingFormat heuristic (R3) | PR3 | PR1 |
| 4 | context.ts: priority chain, `unresolved` seam (R4, D-003) | PR4 | PR1 |
| 5 | state.ts: PluginState read/write, ownership, labels (D-002) | PR5 | PR1 |
| 6 | models-writer.ts: merge/guard/validate/lint/backup + integration (R2, D-001) | PR6 | PR1 |
| 7 | ui/*.ts wrappers | PR7 | PR1 |
| 8 | index.ts `add` wiring (D-003, D-005, D-006, D-007) | PR8 | PR2-5,7 |
| 9 | index.ts `list` + `prune` (D-004) | PR9 | PR2,5,6,8 |
| 10 | Docs + final vitest run | PR10 | PR8-9 |

`stacked-to-main`: PR1..PR10 merge to main in order. `feature-branch-chain`: draft tracker `feature/v0.1-registrar`; PR1 targets tracker, PRn targets PR(n-1)'s branch; only tracker merges to main.

## Phase 0: Bootstrap (D8)
- [x] 0.1 `git init`; `.gitignore` (node_modules/, .pi/, outputs/); commit existing docs.
- [x] 0.2 `package.json`: `pi.extensions: ["./extensions"]`, `scripts.test: "npx vitest run"`.
- [x] 0.3 `npm i -D vitest typebox@1.3.7 @earendil-works/pi-coding-agent`; add `tsconfig.json`, `vitest.config.ts`. (Deviation: `@earendil-works/pi-coding-agent` deferred — not needed until Phase 7 `index.ts` imports Pi types; see apply-progress.)
- [x] 0.4 RED `tests/smoke.test.ts` deliberately failing; `npx vitest run` → fail.
- [x] 0.5 GREEN fix assertion; `npx vitest run` → pass. Gate established.

## Phase 1: detect.ts (R1)
- [x] 1.1 RED `tests/detect.test.ts`: host:port/`/v1`/`/v1/` normalize equal; probe ≤1s; 200+empty-models = failure; unreachable → last error.
- [x] 1.2 GREEN `detect.ts`: `normalize()`, `probe(fetch, ms)`, `probeAll(urls)` (feeds D-004).

## Phase 2: presets.ts (R3)
- [x] 2.1 RED `tests/presets.test.ts`: table for mtplx/omlx/mlx-serve/llama-swap/generic; heuristic qwen→qwen, glm→zai, deepseek→deepseek, else omit; mixed-family server; no Provider-level thinkingFormat.
- [x] 2.2 GREEN `presets.ts`: `provider(kind)` + `thinking(model)` + pre-write override.

## Phase 3: context.ts (R4, D-003)
- [ ] 3.1 RED `tests/context.test.ts`: chain `/v1/models`→`/props`→config.yaml `--ctx-size` (injected fs port), all `verificado`; no source → `{kind:"unresolved"}`, never prompts.
- [ ] 3.2 GREEN `context.ts`: `resolve(model, sources, ports)`; no `ctx`/`ui` import — core stays pure.

## Phase 4: state.ts (D-002)
- [ ] 4.1 RED `tests/state.test.ts`: `PluginState` load/save incl. owner/lastError/model labels; default owner `unknown`; lastError update path (feeds D-004).
- [ ] 4.2 GREEN `state.ts`: read/write `gentle-local-models.json` via injected fs port only.

## Phase 5: models-writer.ts (R2, D-001)
- [ ] 5.1 RED unit `tests/models-writer.test.ts`: fill-never-overwrite; comment guard refuses+reports; invalid mirror-schema blocks write, file untouched; unknown compat key warns, doesn't block; backup rotation caps at 10. Fixture carries real `lmstudio` block.
- [ ] 5.2 GREEN unit: merge/guard/validate/lint/rotation against `WriterPorts`.
- [ ] 5.3 RED integration `tests/models-writer.integration.test.ts` (`os.tmpdir()`): `models.json.<epoch>.bak` written before change (permitted write, D-001); no field overwritten; `verifyWritten()` failure auto-restores newest backup.
- [ ] 5.4 GREEN integration: `commit()` — read→guard→merge→validate→backup→write→verifyWritten→restore.

## Phase 6: ui/*.ts wrappers
- [ ] 6.1 RED `tests/ui.test.ts`: SelectList/SettingsList/BorderedLoader pass through to mocked `ctx.ui` unchanged.
- [ ] 6.2 GREEN `ui/*.ts`: thin wrappers, no business logic.

## Phase 7: index.ts — add (D-003, D-005, D-006, D-007)
- [ ] 7.1 RED `tests/index.add.test.ts`: normalize→probe→kind select (warn omlx/mtplx-rewritten key)→presets.provider; `context.resolve` called ONLY for models missing `contextWindow` (D-005, preserved value never relabeled); `unresolved`+interactive→`ctx.ui.editor(title,"32768")` accepted→`declarado` (D-006); editor cancel(undefined)→omit+`placeholder`+warn (D-007), same path as non-interactive; thinking proposal w/ override; commit()+state.save().
- [ ] 7.2 GREEN `index.ts` `add`, guarding `context.resolve` call per D-005.

## Phase 8: index.ts — list + prune (D-004)
- [ ] 8.1 RED `tests/index.list.test.ts`: base URLs = models.json Providers ∪ state.servers (deduped); each probed; failures render "not detected" + last error; state.lastError updated.
- [ ] 8.2 GREEN `index.ts` `list` via `detect.probeAll` + `state.ts`.
- [ ] 8.3 RED `tests/index.prune.test.ts`: any local Provider incl. external; ownership per row; ONE confirmation per run; backup before any change.
- [ ] 8.4 GREEN `index.ts` `prune`.

## Phase 9: Docs & final verification
- [ ] 9.1 `extensions/local-models/README.md`: dev loop — symlink, `/reload` (D7).
- [ ] 9.2 `tests/MANUAL-E2E.md`: checklist — mlx-serve `:11234`, llama-swap `:8080`, then `/model` + `pi --list-models`.
- [ ] 9.3 Full `npx vitest run` green; confirm only `~/.pi/agent/models.json` (+ rotating `.bak`s) and `~/.pi/agent/gentle-local-models.json` are ever written (ADR-0001).
