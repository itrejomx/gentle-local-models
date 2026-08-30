# Exploration: v0.1 — Registrar (PRD R1-R4), gentle-local-models

> Consolidated from the 2026-08-29/30 grill + spike session. Engram twin: `sdd/v0.1-registrar/explore` (obs 2265). Sources: 01-plugin-modelos-locales-pi.md (revised PRD, authoritative), CONTEXT.md, WAYFINDER.md, docs/adr/0001-register-and-validate-never-assign.md, Engram `pi-local-models/*`.

## Problem Summary

Local models sit behind four OpenAI-compatible Servers (mtplx, oMLX, mlx-serve, llama-swap) routed to SDD phases via gentle-pi. Four failure modes go undetected mid-cycle today: (1) Pi's declared `contextWindow` is never checked against the Server's real limit; (2) three writers touch `~/.pi/agent/models.json` (user/plugin, `omlx launch pi`, `mtplx start pi`), risking silent loss of curated config; (3) Serving Mode (On-Demand vs Single-Model) is ignored, causing concurrent agents to evict each other's models; (4) gentle-pi already owns an assigner (`/gentle:models`), so a second one would duplicate it and race for file ownership.

## Verified Technical Constraints (evidence)

- **gentle-pi**: command `/gentle:models` only (`extensions/gentle-ai.ts:7676`; forbidden aliases in `tests/runtime-harness.mjs:47-62`); global Routing file `~/.pi/gentle-ai/models.json` (`:1122-1128`, legacy project fallback read-only `:1244-1250`); flat unversioned schema silently drops unsafe keys (`:928-946`); applied at `session_start` (`:7396-7399`, `:1713-1793`); picker reads `ctx.modelRegistry.getAvailable()` (`:1817-1824`) — already includes custom providers, confirming a plugin-written Provider needs zero gentle-pi changes to surface.
- **Pi**: `contextWindow` drives compaction (`core/compaction/compaction.js:160-163`, reserve 16384; default 128000 at `core/provider-composer.js:72`); `models.json` validated with TypeBox (`core/model-config.js:181-250`) — **one bad field empties the entire provider map**; file read via `stripJsonComments`; built-in `llama.cpp` provider (`extensions/llama/provider.js`) needs a router API neither llama-swap nor mlx-serve fully implement, falling back to the 128000 default.
- **Servers**: llama-swap context truth is `--ctx-size` in `config.yaml` (no structured API context); oMLX exposes `max_model_len`/`max_context_window` (`api/openai_models.py:465`, `server.py:2732`, `engine_pool.py` LRU); mtplx exposes `context_length`/`context_window_policy` (`server/openai.py:25514`, CLI-only `mtplx settings get`), writer at `mtplx/pi.py:177-262` replaces `providers.mtplx` byte-for-byte; mlx-serve exposes `meta.context_length` and dynamic `memory.max_safe_context` (verified live `:11234`, tool-calling probe OK).

## Affected Areas (v0.1 scope only)

`index.ts` (subset: `add`/`list`/`prune`), `detect.ts`, `presets.ts`, `models-writer.ts`, `state.ts` (`~/.pi/agent/gentle-local-models.json`), `context.ts`, `ui/`. Out of v0.1 scope: `check.ts`, `probes.ts`, `routing-reader.ts` (v0.2, R5-R8). Never written: `~/.pi/gentle-ai/models.json`, `models.export.json`, `subagents.json` (ADR-0001 boundary, enforced in `openspec/config.yaml`).

## Chosen Approach — ADR-0001 Boundary

"Register and validate, never assign" (accepted). Two responsibilities only: register Servers as Pi Providers, validate gentle-pi's Routing (read-only). Accepted tradeoff: three separate user steps instead of one unified flow, in exchange for zero-regression-by-construction and upstream-PR viability.

## Alternatives Considered and Rejected

1. **Own assigner/picker** — duplicates `/gentle:models`, races for an unversioned file's ownership.
2. **Port scanning** — rejected; Servers register by explicit URL only, detection probes only known URLs.
3. **Ollama/vLLM-specific code** — rejected; both fit the `generic` preset.
4. **Pi's built-in `llama.cpp` provider** for llama-swap/mlx-serve — rejected; router API not fully implemented by either, would silently fall back to the 128000 default.
5. **Plugin metadata inside `models.json`** — rejected; risks tripping TypeBox validation and conflates plugin bookkeeping with a file three writers already touch. Chosen instead: separate `gentle-local-models.json` state file.

## Recommendation

Proceed to `sdd-propose` scoped strictly to R1-R4. No remaining architectural fork for v0.1 — approach is cross-confirmed across PRD, ADR, WAYFINDER, and `openspec/config.yaml`.

## Risks for v0.1

1. Three writers of `models.json` (user/plugin, `omlx launch pi`, `mtplx start pi`) — writer must tolerate external overwrites between runs.
2. Permissive-but-fatal schema validation — fatal on one bad known field, silently permissive on unknown `compat` keys; writer must self-lint.
3. Comment stripping on read — decision made to refuse writing when comments are present rather than risk destroying them.
4. No git repo yet (`openspec/config.yaml`) — no VCS safety net beyond the writer's own backup-before-write.
5. No test runner yet — strict TDD enabled, vitest not installed; first apply batch must install/wire it before implementation code.

## Open Items for sdd-propose

- Out of scope (explicitly deferred, product-owned): context thresholds per Routable Agent (§8 Q1, R5/v0.2).
- Schema-validation strategy for R2 (import Pi's real TypeBox validator vs. locally mirrored schema — drift risk either way).
- Full `compat` preset table for R3 beyond mtplx's verbatim block — should be pulled from the `pi-local-models/compat/presets` decision rather than re-derived.
- Backup retention policy for R2 (single vs. rotating) — likely already decided under `pi-local-models/writer/state-file-and-guards`; proposal should confirm/cite.
- R4's "ask at registration" fallback — blocking prompt vs. placeholder-with-warning; should become an explicit acceptance criterion.

## Ready for Proposal

Yes.
