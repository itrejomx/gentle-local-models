# Specification: models-json-writer (R2)

## Purpose
Write `~/.pi/agent/models.json` safely: fill-never-overwrite, backups,
validation, and explicit prune.

## Requirements

### Requirement: Fill-never-overwrite merge
The system MUST NOT overwrite existing `name`, `contextWindow`, `maxTokens`,
`reasoning`, `input`, `compat`, or `api` fields; it MUST only fill missing
fields with conservative defaults; new models MUST be added with `name = id`;
the target Provider — new OR existing — MUST be written with
`api: "openai-completions"` at the Provider level whenever it is absent
there, since Pi's provider composer requires `api` at the Provider or Model
level to resolve requests (`core/provider-composer.js:48-52`); every commit
MUST also enforce that requirement (Provider-level `api` OR `api` on every
one of its models) for the Provider it is writing, whether newly created or
pre-existing.

#### Scenario: Existing values preserved, missing values filled
- GIVEN a model with `contextWindow` already set and `maxTokens` missing,
  WHEN the writer runs, THEN `contextWindow` is unchanged and `maxTokens`
  gets a conservative default.

### Requirement: Unserved Models preserved; prune is explicit
Models no longer reported by a Server MUST remain registered as Unserved
Models until removed via `/local-models prune` with confirmation.

#### Scenario: Model disappears from its Server
- GIVEN a model previously registered but no longer reported, WHEN the writer
  runs, THEN it stays registered as an Unserved Model.

### Requirement: Prune applies to any local Provider, shows ownership, one confirmation per run
`prune` MUST operate on any local Provider in `models.json`, including ones
the plugin did not create, MUST show each Provider's ownership (plugin-owned
vs. external), and MUST request exactly one confirmation for the whole run.

#### Scenario: Pruning a hand-curated Provider
- GIVEN a Provider the plugin never wrote, WHEN the user runs `prune`, THEN
  candidate Unserved Models are listed with an ownership label, one
  confirmation covers the whole run, and a backup is written before any
  change.

### Requirement: Rotating backups before every plugin write
Every write the plugin makes MUST be preceded by a backup, keeping the 10
most recent rotating backups. Backups MUST NOT be created for writes the
plugin did not make.

#### Scenario: Backup rotation cap
- GIVEN 10 existing backups, WHEN the plugin writes an 11th time, THEN a new
  backup is added and the oldest is pruned, keeping exactly 10.

### Requirement: Pre-write validation against the mirrored schema
The system MUST validate the resulting `models.json` against Pi's mirrored
schema before writing.

#### Scenario: Invalid result blocks the write
- GIVEN a merge result that fails mirrored-schema validation, WHEN the writer
  attempts to save, THEN the write is aborted and the file is unchanged.

### Requirement: Read-back after write with auto-restore
After writing, the system MUST read the file back through Pi's own load
path; if the Provider map comes back empty, it MUST restore the newest
backup automatically.

#### Scenario: Post-write Provider map is empty
- GIVEN a write that produces an empty Provider map on read-back, WHEN this
  is detected, THEN the newest backup is restored automatically and the user
  is informed.

### Requirement: Refuse to write files containing comments
The system MUST refuse to write `models.json` if the existing file contains
comments, and MUST tell the user why.

#### Scenario: Comment detected
- GIVEN a `models.json` containing a comment, WHEN the writer runs, THEN it
  aborts and reports the refusal reason.

### Requirement: Compat-key lint
The system MUST lint `compat` keys against a known list and warn on any
unrecognized key, without blocking the write.

#### Scenario: Unknown compat key
- GIVEN a `compat` block with an unrecognized key, WHEN the writer runs,
  THEN a warning is shown and the write still proceeds.
