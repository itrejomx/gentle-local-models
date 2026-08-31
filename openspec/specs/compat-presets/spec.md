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

### Requirement: Per-model override before write
The system MUST let the user override the proposed `thinkingFormat` for any
model before the write occurs.

#### Scenario: User overrides the heuristic
- GIVEN a proposed `thinkingFormat` the user disagrees with, WHEN the user
  overrides it before confirming, THEN the overridden value is written
  instead of the heuristic's.
