# Proposal: v0.1 — Registrar (PRD R1–R4)

## Intent

Registering a local Server in Pi today means hand-editing `~/.pi/agent/models.json` — a file three writers touch (user/plugin, `omlx launch pi`, `mtplx start pi`) and whose TypeBox validation returns an **empty** Provider map on a single bad field. Pi trusts the declared `contextWindow` blindly for compaction, so an overstated value breaks an SDD cycle mid-run. v0.1 ships `/local-models add | list | prune`: register a Server as a Pi Provider in under 2 minutes without editing JSON, behind a writer that cannot lose curated config.

## Scope

### In Scope

- **R1** — registration by URL: `add`, `list`; `/v1/models` detection with ≤1 s timeout over known base URLs; URL normalization (`host:port`, `.../v1`, `.../v1/`); HTTP 200 with zero models treated as failure; unreachable Server shown as "not detected" with last error.
- **R2** — safe writer: fill-never-overwrite, Unserved Models preserved, `prune` with confirmation, backup before write, pre-write schema validation, comment guard, `compat` key lint.
- **R3** — `compat` presets by Server kind; model-level `thinkingFormat` heuristic with preview and override.
- **R4** — context resolution by source priority and `verified | declared | placeholder` labeling.
- Plugin state file `~/.pi/agent/gentle-local-models.json` (Servers, kind, Serving Mode, plugin-owned Providers, context labels).
- Repo bootstrap: `git init` and vitest install/wiring before any implementation code.

### Out of Scope

- **R5–R8** (Check, tool-calling probes, Serving Mode rules, export validation) → v0.2; `check.ts`, `probes.ts`, `routing-reader.ts` are not created here.
- Per-Routable-Agent context thresholds (PRD §8 Q1) — product-owned, deferred to v0.2.
- Any write to `~/.pi/gentle-ai/models.json`, `models.export.json` or `subagents.json` (ADR-0001; the plugin never assigns models to Routable Agents).
- Port scanning; Ollama/vLLM-specific code; runtime installation; footer widget; OAuth Servers.

## Capabilities

### New Capabilities

- `server-registration`: R1 — detection over known base URLs, URL normalization, `add` / `list`.
- `models-json-writer`: R2 — merge policy, backup, validation, comment guard, `prune`.
- `compat-presets`: R3 — preset table keyed by Server kind, `thinkingFormat` heuristic.
- `context-resolution`: R4 — context source priority and labeling.
- `plugin-state`: state file schema, ownership and invariants.

### Modified Capabilities

- None — `openspec/specs/` is empty; this is the first change.

## Approach

One Server contract (OpenAI-compatible at a base URL); per-Server differences live in data tables, not code branches. Four open items from exploration are settled below.

### D1 — R2 schema validation: locally mirrored schema, not an import

Pi **does not expose its validator**. In `@earendil-works/pi-coding-agent@0.84.4`, `package.json` `exports` allows only `.`, `./rpc-entry` and `./client`; `dist/index.d.ts` exports no `ModelConfig` and no TypeBox schema (`ProviderConfig` / `ProviderModelConfig` are types, erased at runtime). Deep-importing `dist/core/model-config.js` is blocked by the exports map and would pin a private path that can move on any patch release — that is not "runtime coupling", it is a broken import.

Decision: mirror the schema shape from `core/model-config.d.ts:36-119` as plugin-owned data, and bound the drift:

1. The mirror stays **as permissive as Pi's** (Pi sets no `additionalProperties: false`). Unknown `compat` keys warn via the R2 lint; they never block a write.
2. The mirror is strict only about what the plugin itself writes.
3. The plugin state records the Pi version the mirror was validated against, so a version change surfaces as a review flag.
4. **Read-back after write**: reload the written file through Pi's own load path; if the Provider map comes back empty, restore the backup automatically. Drift then becomes detected-and-reverted instead of silent, which is the failure mode that actually matters (one bad field disables every custom Provider at once).

### D2 — R3 preset table (source: `pi-local-models/compat/presets`)

Provider-level `compat`, seeded from blocks that work today:

| Server kind | Provider `compat` | Notes |
|---|---|---|
| `mtplx` | `supportsDeveloperRole:false`, `supportsReasoningEffort:false`, `maxTokensField:"max_tokens"` | Verbatim from `mtplx/pi.py:242-262`; also header `x-mtplx-client`. Single-Model Server |
| `omlx` | same three flags | `authHeader: true` (`integrations/pi.py`). `omlx launch pi` writes no `compat` at all; the preset fills that gap |
| `mlx-serve` | same three flags | Verified live in `~/.pi/agent/models.json` (spike, `:11234`) |
| `llama-swap` | same three flags | No provider-level `thinkingFormat`: one Server, mixed model families |
| `generic` | same three flags | No headers, no `authHeader` assumption |

`thinkingFormat` is **model-level only**, proposed by family heuristic when `reasoning: true` (`qwen*` → `qwen`, `glm*` → `zai`, `deepseek*` → `deepseek`, otherwise omitted), previewed before write, overridable per model. Live evidence for keeping it off the Provider: the user's `lmstudio` block declares provider-level `thinkingFormat: "qwen"` while serving `glm-4.7-flash`, which needs `zai`.

### D3 — R2 backup retention: rotating, timestamped, capped

`pi-local-models/writer/merge-policy` (#2231) and `pi-local-models/writer/state-file-and-guards` (#2245) both mandate a backup before every write but leave retention open. Decision: **rotating** backups named `models.json.<epoch>.bak` (the format the spike already used), keeping the 10 most recent and pruning older ones. A single `models.json.bak` would be overwritten by the plugin's own next run — precisely the case where an external writer (`omlx launch pi`, `mtplx start pi`) clobbered the file between runs, so the only pre-damage copy would be destroyed by the recovery attempt. The file is a few KB and there is no VCS safety net over `~/.pi/agent/`.

### D4 — R4 fallback: blocking prompt (acceptance criterion)

When no context source resolves, `add` **MUST** block per model on a prompt pre-filled with a conservative `32768`, label the result `placeholder`, and **MUST NOT** infer a larger value. In non-interactive invocation it **MUST** omit `contextWindow` entirely (Pi falls back to 128000, `core/provider-composer.js:72`), label the model `placeholder`, and print a warning naming every such model; registration still succeeds so the model appears in `/model` and `/gentle:models`.

Rationale: under fill-never-overwrite a placeholder is sticky — the plugin will never correct it, and v0.1 has no Check. The error costs are asymmetric: understating only causes early compaction, overstating causes a hard Server rejection mid-cycle, which is the failure this whole PRD exists to prevent.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `index.ts` | New | `/local-models` with `add`, `list`, `prune` (no `check` in v0.1) |
| `detect.ts` | New | `/v1/models` probe, URL normalization, zero-models-is-failure |
| `presets.ts` | New | Preset table (D2) + `thinkingFormat` heuristic |
| `models-writer.ts` | New | Merge, backup rotation, mirrored-schema validation, comment guard, `compat` lint |
| `state.ts` | New | `~/.pi/agent/gentle-local-models.json` |
| `context.ts` | New | Source priority and labeling (D4) |
| `ui/` | New | `SelectList`, `SettingsList`, `BorderedLoader` (pi-tui) |
| `package.json`, `vitest.config.ts`, `.gitignore` | New | Repo bootstrap: git init + vitest before implementation |
| `~/.pi/agent/models.json` | Modified at runtime | Only file the plugin writes; never gentle-pi's files |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Mirrored schema drifts from Pi's | Med | Permissive mirror + version pin + read-back-and-restore (D1) |
| External writer clobbers `models.json` between runs | High | Fill-never-overwrite; rotating backups (D3); writer re-reads on every run |
| Bad write disables every custom Provider | Low | Pre-write validation + post-write read-back + automatic restore |
| Existing file contains comments | Med | Refuse to write, tell the user (guard from #2245) |
| Placeholder context persists uncorrected | Med | Blocking prompt (D4), `placeholder` label in state, Check in v0.2 |
| No git repo and no test runner yet | High | First apply batch: `git init`, then vitest, before any implementation code |

## Rollback Plan

1. Runtime: `models.json` is restored from the newest `models.json.<epoch>.bak`; the read-back check does this automatically when validation fails after a write. Manual `cp` of any retained backup is the fallback.
2. Plugin: remove the extension from `.pi/extensions/` (or `pi uninstall`) and delete `~/.pi/agent/gentle-local-models.json`. Providers already written remain valid and self-contained — no plugin runtime is required for Pi to keep using them.
3. Repo: revert the change branch. No gentle-pi file is ever touched, so `/gentle:models` and Routing cannot regress by construction (ADR-0001).

## Dependencies

- Pi ≥ 0.84.x (`~/.pi/agent/models.json` schema, `ctx.modelRegistry`), pi-tui for UI.
- vitest — **not installed**; strict TDD gate requires it in the first apply batch.
- Git — repo is **not yet a git repository**; `git init` is task 1.
- At least one reachable local Server for integration verification (llama-swap `:8080`, mlx-serve `:11234` verified live).

## Success Criteria

- [ ] A new Server is registered in under 2 minutes with no manual JSON editing, and appears in `/model` and `/gentle:models` without a restart.
- [ ] R1: unreachable Server and 200-with-zero-models are both reported as failures, never as success.
- [ ] R2: no existing field in `models.json` is ever overwritten; every write is preceded by a backup; a file with comments is refused; a validation failure restores the backup.
- [ ] R3: each Server kind writes its preset block; `thinkingFormat` is proposed at model level only and is previewed before writing.
- [ ] R4: every `contextWindow` carries a `verified | declared | placeholder` label, and no value is ever inferred upward without the user.
- [ ] `npx vitest run` passes; every module lands test-first.
- [ ] Zero writes to `~/.pi/gentle-ai/models.json`, `models.export.json` or `subagents.json`.

## Proposal question round

Not asked interactively (executor has no direct user channel). Answers would refine, not block, the spec phase:

1. **Placeholder default** — is `32768` the right conservative pre-fill for D4, or should the prompt refuse a default entirely and require a typed number?
2. **Backup depth** — is 10 rotating backups right, or should retention be time-based (e.g. 7 days) given `omlx`/`mtplx` may write many times a day?
3. **`prune` blast radius** — should `prune` be able to remove Unserved Models from a Provider the plugin did not create (e.g. a hand-curated `lmstudio`), or only from plugin-owned Providers?
4. **`omlx` / `mtplx` Providers** — when the user registers a Server whose Provider key is one those tools rewrite, should v0.1 warn at registration time, or stay silent until the v0.2 Check?
