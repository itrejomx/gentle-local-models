# Specification: context-resolution (R4)

## Purpose
Resolve each model's `contextWindow` from the highest-confidence available
source and label its confidence.

## Requirements

### Requirement: Source priority chain and labeling
The system MUST resolve `contextWindow` in this order: (1) `max_model_len`,
`context_length`, or `meta.context_length` from `/v1/models`; (2)
`default_generation_settings.n_ctx` from `/props`; (3) `--ctx-size` from
llama-swap's `config.yaml`; (4) an interactive prompt. Sources (1), (2), and
(3) MUST be labeled `verificado` — each is the Server's own ground truth
(live API or the file that actually launched it), read rather than guessed;
only the prompt answer (source 4) MUST be labeled `declarado`.

#### Scenario: Live Server value wins
- GIVEN a Server reporting `max_model_len` on `/v1/models`, WHEN resolution
  runs, THEN that value is used and labeled `verificado`.

#### Scenario: llama-swap static config used
- GIVEN no live-probe value but a `config.yaml` with `--ctx-size`, WHEN
  resolution runs, THEN that value is used and labeled `verificado`, since
  `config.yaml` is how llama-swap was actually launched and a later v0.2
  Check can re-read it to detect drift.

### Requirement: Ask-at-registration prompt
When no source resolves interactively, the system MUST prompt per model,
pre-filled with a conservative `32768`, editable by the user; the resulting
value MUST be labeled `declarado`, never `verificado`.

#### Scenario: User accepts the pre-filled default
- GIVEN no resolvable source, WHEN the user accepts `32768` unedited, THEN
  `contextWindow` is set to `32768` and labeled `declarado`.

### Requirement: Non-interactive fallback omits contextWindow
In a non-interactive invocation, when no source resolves, the system MUST
omit `contextWindow` entirely (rather than guessing), label the model
`placeholder`, and print a warning naming every affected model;
registration MUST still succeed.

#### Scenario: Non-interactive add with no source
- GIVEN a non-interactive `add` and no resolvable context source, WHEN
  registration completes, THEN `contextWindow` is omitted, the model is
  labeled `placeholder`, a warning names it, and it still appears in
  `/model`.

### Requirement: Dynamic max-safe-context never overwrites contextWindow
A Server-reported dynamic limit (e.g., `memory.max_safe_context` in
mlx-serve) MUST NOT replace or alter the stored `contextWindow` value or its
label.

#### Scenario: mlx-serve reports a smaller dynamic limit
- GIVEN a registered model with `contextWindow` labeled `verificado`, WHEN
  mlx-serve later reports a smaller `memory.max_safe_context`, THEN the
  stored `contextWindow` and its label are unchanged.
