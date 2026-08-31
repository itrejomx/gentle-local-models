# Specification: compat-presets (R3)

## Purpose
Provide per-Server-kind compat blocks and model-level thinkingFormat
proposals as data, not code branches.

## Requirements

### Requirement: Preset table by Server kind
The system MUST provide a data-driven preset table covering `mtplx`, `omlx`,
`mlx-serve`, `llama-swap`, and `generic`, and MUST apply the selected kind's
Provider-level `compat` block at registration.

#### Scenario: Kind selection applies its preset
- GIVEN the user selects Server kind `omlx` during `add`, WHEN the Provider
  is written, THEN the `omlx` preset's `compat` block is applied unmodified.

### Requirement: Model-level thinkingFormat by family heuristic
For any model with `reasoning: true`, the system MUST propose
`thinkingFormat` by family heuristic (`qwen*` → `qwen`, `glm*` → `zai`,
`deepseek*` → `deepseek`, otherwise omit), MUST show the proposal before
writing, and MUST NOT set it at the Provider level.

#### Scenario: Mixed-family On-Demand Server
- GIVEN a `llama-swap` Server serving both a `qwen*` and a `glm*` model,
  WHEN presets are applied, THEN each model gets its own family-matched
  `thinkingFormat` and no Provider-level `thinkingFormat` is set.

### Requirement: Reasoning confirm is batched, not per-model
For v0.1.1, the system MUST confirm reasoning/thinkingFormat proposals for
every family-matched, undeclared model in ONE confirm per `add` run instead
of one dialog per model. Accepting sets `reasoning: true` and the
family-matched `thinkingFormat` on every candidate; declining sets neither
field on any of them. A per-model override control is deferred to v0.2 — for
v0.1.1, overriding a specific model requires re-running `add` for that
Server.

#### Scenario: Mixed-family batch confirm
- GIVEN a `llama-swap` Server serving both a `qwen*` and a `glm*` model,
  WHEN the user accepts the one batched confirm, THEN both models are
  written with `reasoning: true` and their own family-matched
  `thinkingFormat`; declining leaves neither field set on either model.

### Requirement: `nothink` in a model id auto-declines the reasoning proposal
A model id containing `nothink` (case-insensitive) MUST be excluded from the
reasoning proposal entirely — no confirm, `reasoning` and `thinkingFormat`
both omitted — and MUST be listed in a notice distinct from the batch
confirm. This check runs before the family-heuristic match and does not
apply to a Server-declared reasoning capability, which is verified
regardless of the id.

#### Scenario: nothink variant excluded from the batch
- GIVEN a Server serving both `qwen3-4b` and `qwen3-4b-nothink`, WHEN `add`
  proposes reasoning, THEN only `qwen3-4b` is offered in the batch confirm
  and `qwen3-4b-nothink` is reported separately, with neither `reasoning`
  nor `thinkingFormat` set on it.
