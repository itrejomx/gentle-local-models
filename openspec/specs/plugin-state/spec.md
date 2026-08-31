# Specification: plugin-state

## Purpose
Track known Servers, Provider ownership, and context labels in
`~/.pi/agent/gentle-local-models.json`, without ever touching gentle-pi's
files.

## Requirements

### Requirement: State file scope and content
The system MUST persist known Servers, per-Provider ownership (plugin-owned
vs. external), per-model context labels, and the Pi version the mirrored
schema was validated against, in `~/.pi/agent/gentle-local-models.json`.

#### Scenario: State records ownership for prune
- GIVEN a Provider created by `add`, WHEN state is saved, THEN it is recorded
  as plugin-owned so a later `prune` can distinguish it from external
  Providers.

### Requirement: ADR-0001 boundary — never write gentle-pi's files
The plugin MUST NOT write to `~/.pi/gentle-ai/models.json`,
`models.export.json`, or `subagents.json` under any operation in this
change.

#### Scenario: No writes outside the plugin's own files
- GIVEN any `add`, `list`, or `prune` operation, WHEN it completes, THEN only
  `~/.pi/agent/models.json`, its rotating backups (`models.json.<epoch>.bak`,
  capped at 10), and `~/.pi/agent/gentle-local-models.json` have been
  written.
