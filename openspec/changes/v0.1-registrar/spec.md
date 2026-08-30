# Specification — v0.1 Registrar (R1–R4)

`openspec/specs/` is empty (first change): every capability below is a NEW full
spec, not a delta. Scope: R1–R4 only. R5–R8 (Check, tool-calling probes,
Serving Mode rules, export validation) are OUT — v0.2.

## Capability: server-registration (R1)

### Purpose
Register a local Server as a Pi Provider by URL, with reachability detection
and normalization.

### Requirements

#### Requirement: Register and list Servers by URL
The system MUST provide `/local-models add <baseUrl>` and
`/local-models list`, registering a Server as a Provider without manual JSON
editing.

##### Scenario: Successful registration and listing
- GIVEN a reachable Server at a base URL, WHEN the user runs `add <baseUrl>`,
  THEN it is registered as a Provider and appears with its status in `list`.

#### Requirement: URL normalization
The system MUST normalize base URL input accepting `host:port`, a trailing
`/v1`, or a trailing `/v1/`.

##### Scenario: Equivalent inputs normalize to one Provider
- GIVEN inputs `host:port`, `host:port/v1`, `host:port/v1/`, WHEN each is used
  with `add`, THEN all resolve to the same normalized base URL.

#### Requirement: Reachability probe, 1-second timeout, no port scan
The system MUST probe `/v1/models` on each known base URL (existing Providers
plus Servers saved in plugin state) with timeout ≤ 1 s, and MUST NOT scan
ports.

##### Scenario: Zero-models response is a failure
- GIVEN a Server that responds 200 with an empty model list, WHEN probed,
  THEN it is treated as a failure, not a success.

##### Scenario: Unreachable Server reported with last error
- GIVEN a Server that does not respond within 1 s, WHEN probed, THEN it is
  shown as "not detected" with the last error.

#### Requirement: Warn on omlx/mtplx-rewritten Provider keys
The system MUST warn immediately during `add` when the target Provider key is
one that `omlx launch pi` or `mtplx start pi` would rewrite.

##### Scenario: Warning shown at registration time
- GIVEN a Provider key matching the omlx/mtplx rewrite pattern, WHEN `add`
  registers it, THEN a warning is shown immediately, not deferred to a
  future Check.

## Capability: models-json-writer (R2)

### Purpose
Write `~/.pi/agent/models.json` safely: fill-never-overwrite, backups,
validation, and explicit prune.

### Requirements

#### Requirement: Fill-never-overwrite merge
The system MUST NOT overwrite existing `name`, `contextWindow`, `maxTokens`,
`reasoning`, `input`, or `compat` fields; it MUST only fill missing fields
with conservative defaults; new models MUST be added with `name = id`.

##### Scenario: Existing values preserved, missing values filled
- GIVEN a model with `contextWindow` already set and `maxTokens` missing,
  WHEN the writer runs, THEN `contextWindow` is unchanged and `maxTokens`
  gets a conservative default.

#### Requirement: Unserved Models preserved; prune is explicit
Models no longer reported by a Server MUST remain registered as Unserved
Models until removed via `/local-models prune` with confirmation.

##### Scenario: Model disappears from its Server
- GIVEN a model previously registered but no longer reported, WHEN the writer
  runs, THEN it stays registered as an Unserved Model.

#### Requirement: Prune applies to any local Provider, shows ownership, one confirmation per run
`prune` MUST operate on any local Provider in `models.json`, including ones
the plugin did not create, MUST show each Provider's ownership (plugin-owned
vs. external), and MUST request exactly one confirmation for the whole run.

##### Scenario: Pruning a hand-curated Provider
- GIVEN a Provider the plugin never wrote, WHEN the user runs `prune`, THEN
  candidate Unserved Models are listed with an ownership label, one
  confirmation covers the whole run, and a backup is written before any
  change.

#### Requirement: Rotating backups before every plugin write
Every write the plugin makes MUST be preceded by a backup, keeping the 10
most recent rotating backups. Backups MUST NOT be created for writes the
plugin did not make.

##### Scenario: Backup rotation cap
- GIVEN 10 existing backups, WHEN the plugin writes an 11th time, THEN a new
  backup is added and the oldest is pruned, keeping exactly 10.

#### Requirement: Pre-write validation against the mirrored schema
The system MUST validate the resulting `models.json` against Pi's mirrored
schema before writing.

##### Scenario: Invalid result blocks the write
- GIVEN a merge result that fails mirrored-schema validation, WHEN the writer
  attempts to save, THEN the write is aborted and the file is unchanged.

#### Requirement: Read-back after write with auto-restore
After writing, the system MUST read the file back through Pi's own load
path; if the Provider map comes back empty, it MUST restore the newest
backup automatically.

##### Scenario: Post-write Provider map is empty
- GIVEN a write that produces an empty Provider map on read-back, WHEN this
  is detected, THEN the newest backup is restored automatically and the user
  is informed.

#### Requirement: Refuse to write files containing comments
The system MUST refuse to write `models.json` if the existing file contains
comments, and MUST tell the user why.

##### Scenario: Comment detected
- GIVEN a `models.json` containing a comment, WHEN the writer runs, THEN it
  aborts and reports the refusal reason.

#### Requirement: Compat-key lint
The system MUST lint `compat` keys against a known list and warn on any
unrecognized key, without blocking the write.

##### Scenario: Unknown compat key
- GIVEN a `compat` block with an unrecognized key, WHEN the writer runs,
  THEN a warning is shown and the write still proceeds.

## Capability: compat-presets (R3)

### Purpose
Provide per-Server-kind compat blocks and model-level thinkingFormat
proposals as data, not code branches.

### Requirements

#### Requirement: Preset table by Server kind
The system MUST provide a data-driven preset table covering `mtplx`, `omlx`,
`mlx-serve`, `llama-swap`, and `generic`, and MUST apply the selected kind's
Provider-level `compat` block at registration.

##### Scenario: Kind selection applies its preset
- GIVEN the user selects Server kind `omlx` during `add`, WHEN the Provider
  is written, THEN the `omlx` preset's `compat` block is applied unmodified.

#### Requirement: Model-level thinkingFormat by family heuristic
For any model with `reasoning: true`, the system MUST propose
`thinkingFormat` by family heuristic (`qwen*` → `qwen`, `glm*` → `zai`,
`deepseek*` → `deepseek`, otherwise omit), MUST show the proposal before
writing, and MUST NOT set it at the Provider level.

##### Scenario: Mixed-family On-Demand Server
- GIVEN a `llama-swap` Server serving both a `qwen*` and a `glm*` model,
  WHEN presets are applied, THEN each model gets its own family-matched
  `thinkingFormat` and no Provider-level `thinkingFormat` is set.

#### Requirement: Per-model override before write
The system MUST let the user override the proposed `thinkingFormat` for any
model before the write occurs.

##### Scenario: User overrides the heuristic
- GIVEN a proposed `thinkingFormat` the user disagrees with, WHEN the user
  overrides it before confirming, THEN the overridden value is written
  instead of the heuristic's.

## Capability: context-resolution (R4)

### Purpose
Resolve each model's `contextWindow` from the highest-confidence available
source and label its confidence.

### Requirements

#### Requirement: Source priority chain and labeling
The system MUST resolve `contextWindow` in this order: (1) `max_model_len`,
`context_length`, or `meta.context_length` from `/v1/models`; (2)
`default_generation_settings.n_ctx` from `/props`; (3) `--ctx-size` from
llama-swap's `config.yaml`; (4) an interactive prompt. Sources (1), (2), and
(3) MUST be labeled `verificado` — each is the Server's own ground truth
(live API or the file that actually launched it), read rather than guessed;
only the prompt answer (source 4) MUST be labeled `declarado`.

##### Scenario: Live Server value wins
- GIVEN a Server reporting `max_model_len` on `/v1/models`, WHEN resolution
  runs, THEN that value is used and labeled `verificado`.

##### Scenario: llama-swap static config used
- GIVEN no live-probe value but a `config.yaml` with `--ctx-size`, WHEN
  resolution runs, THEN that value is used and labeled `verificado`, since
  `config.yaml` is how llama-swap was actually launched and a later v0.2
  Check can re-read it to detect drift.

#### Requirement: Ask-at-registration prompt
When no source resolves interactively, the system MUST prompt per model,
pre-filled with a conservative `32768`, editable by the user; the resulting
value MUST be labeled `declarado`, never `verificado`.

##### Scenario: User accepts the pre-filled default
- GIVEN no resolvable source, WHEN the user accepts `32768` unedited, THEN
  `contextWindow` is set to `32768` and labeled `declarado`.

#### Requirement: Non-interactive fallback omits contextWindow
In a non-interactive invocation, when no source resolves, the system MUST
omit `contextWindow` entirely (rather than guessing), label the model
`placeholder`, and print a warning naming every affected model;
registration MUST still succeed.

##### Scenario: Non-interactive add with no source
- GIVEN a non-interactive `add` and no resolvable context source, WHEN
  registration completes, THEN `contextWindow` is omitted, the model is
  labeled `placeholder`, a warning names it, and it still appears in
  `/model`.

#### Requirement: Dynamic max-safe-context never overwrites contextWindow
A Server-reported dynamic limit (e.g., `memory.max_safe_context` in
mlx-serve) MUST NOT replace or alter the stored `contextWindow` value or its
label.

##### Scenario: mlx-serve reports a smaller dynamic limit
- GIVEN a registered model with `contextWindow` labeled `verificado`, WHEN
  mlx-serve later reports a smaller `memory.max_safe_context`, THEN the
  stored `contextWindow` and its label are unchanged.

## Capability: plugin-state

### Purpose
Track known Servers, Provider ownership, and context labels in
`~/.pi/agent/gentle-local-models.json`, without ever touching gentle-pi's
files.

### Requirements

#### Requirement: State file scope and content
The system MUST persist known Servers, per-Provider ownership (plugin-owned
vs. external), per-model context labels, and the Pi version the mirrored
schema was validated against, in `~/.pi/agent/gentle-local-models.json`.

##### Scenario: State records ownership for prune
- GIVEN a Provider created by `add`, WHEN state is saved, THEN it is recorded
  as plugin-owned so a later `prune` can distinguish it from external
  Providers.

#### Requirement: ADR-0001 boundary — never write gentle-pi's files
The plugin MUST NOT write to `~/.pi/gentle-ai/models.json`,
`models.export.json`, or `subagents.json` under any operation in this
change.

##### Scenario: No writes outside the plugin's own files
- GIVEN any `add`, `list`, or `prune` operation, WHEN it completes, THEN only
  `~/.pi/agent/models.json`, its rotating backups (`models.json.<epoch>.bak`,
  capped at 10), and `~/.pi/agent/gentle-local-models.json` have been
  written.
