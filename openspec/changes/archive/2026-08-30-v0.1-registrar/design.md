# Design: v0.1 — Registrar (R1–R4)

## Technical Approach

Shell-and-core. One thin Pi-facing shell (`index.ts` + `ui/`) wraps five pure modules
(`detect`, `presets`, `models-writer`, `state`, `context`). Pure modules receive their
I/O as injected ports (`fetch`, `fs`, clock, read-back verifier) and return data; only
the shell touches `ctx`. Per-Server differences live in `presets.ts` data, never in code
branches. Ships as TypeScript source — Pi loads `.ts` extensions through jiti
(`core/extensions/loader.js:1-14`), so there is no build step and no `dist/`.

## Architecture Decisions

### D1 — Shell/core split, ports injected
**Choice**: `ctx` never crosses into core modules; Pi types are imported `import type` only.
**Rejected**: modules calling `ctx.ui`/`ctx.modelRegistry` directly.
**Rationale**: vitest then runs the whole core with zero Pi runtime, which is what makes the
strict-TDD gate cheap. Type-only imports are erased, so no runtime dependency leaks in.

### D2 — Mirrored schema written in TypeBox, from Pi's virtual module
**Choice**: `import { Type } from "typebox"` — `typebox`, `typebox/compile` and
`typebox/value` are VIRTUAL_MODULES Pi injects into extensions
(`core/extensions/loader.js:32-38`, typebox pinned `1.3.7`). Mirror covers only
plugin-written fields, permissive like Pi's (no `additionalProperties: false`).
**Rejected**: deep-import Pi's compiled validator (blocked by the `exports` map);
hand-rolled predicates (drift on literal unions like `thinkingFormat`, `maxTokensField`).
**Rationale**: same validator library and semantics as Pi, zero runtime dependency
(devDependency only, for vitest). Unknown `compat` keys warn via lint, never block.

### D3 — Read-back through Pi's own loader, not a re-parse
**Choice**: after write, `await ctx.modelRegistry.refresh({ allowNetwork: false })`, then
`getError()` and `find(providerKey, modelId)`. `refresh()` calls `ModelConfig.load()`
(`core/model-runtime.js:501-502`), and load returns an **empty Map plus an error string**
on TypeBox failure (`core/model-config.js:212-238`) — exactly the failure this guards.
Failure ⇒ restore newest backup, refresh again, report. The same call makes the Provider
visible in `/model` and `/gentle:models` with no restart.
**Rejected**: `pi.registerProvider()` in-memory registration — not persisted, invisible to
other sessions and to `pi --list-models`.
**Testability**: the shell passes this as a `verifyWritten` port; tests stub it.

### D4 — Ownership lives in plugin state, never inside `models.json`
**Choice**: `state.providers[key].owner = "plugin" | "external"` is the ledger. Foreign
writers are a static table (`omlx` → `omlx launch pi`, `mtplx` → `mtplx start pi`), used to
warn at `add`. `prune` reach = any **local** Provider (loopback/private-host `baseUrl`),
owner shown per row, one confirmation per run, backup first.
**Rejected**: an ownership marker field in `models.json` (any unknown field is a schema risk
on a file that fails closed).
**Rationale**: state loss degrades to `owner: "unknown"` — `prune` and `list` still work.

### D5 — Pre-filled prompt uses `ctx.ui.editor`, not `ctx.ui.input`
**Choice**: `ctx.ui.editor(title, "32768")` for the R4 fallback.
**Evidence**: `ui.input(title, placeholder)` **ignores** the placeholder — the interactive
component takes `_placeholder` and never passes it to `new Input()`
(`modes/interactive/components/extension-input.js:25-44`); it cannot pre-fill. `ui.editor`
seeds real editable text (`interactive-mode.js:2069-2071`).
**Rationale**: the user's decision was an *editable* 32768, not a hint. Result is labeled
`declarado`. `!ctx.hasUI` ⇒ omit `contextWindow`, label `placeholder`, warn per model.

### D6 — Errors are values; only two conditions abort
**Choice**: core returns discriminated results; the shell maps them to `ctx.ui.notify`.
`WriteOutcome` = `written` | `refused` (comments) | `invalid` (pre-write, file untouched) |
`restored` (read-back failed, backup restored, re-verified) | `rolled-back` (read-back
failed, no backup existed) | `restore-failed` (read-back failed, restore itself failed —
failed write left in place, reported honestly) | `write-failed` (an injected port itself
rejected mid-stage; names the stage and the file state left behind). Lint warnings ride
along with `written`. PR6 review split the original single ambiguous `restored` variant
(which used a `backup: ""` sentinel to mean "nothing was restored") into these distinct,
type-level-discriminated kinds, and wrapped every port call so no thrown exception can
leave `models.json` half-written or escape `commit()` unconverted.
**Rationale**: no thrown exception can leave `models.json` half-written; every abort names
the file state it left behind.

### D7 — Package layout and dev loop
Repo root is the npm package. `package.json` declares `pi.extensions: ["./extensions"]`
(same shape gentle-pi uses); sources live in `extensions/local-models/index.ts` + siblings;
relative imports carry the explicit `.ts` extension. Dev loop: symlink
`.pi/extensions/local-models` → `extensions/local-models`, then `/reload`
(`docs/extensions.md:7,119-120`). No bundler, no `dist`, no postinstall.

### D8 — Bootstrap order (strict TDD gate)
1. `git init` + `.gitignore` (`node_modules/`, `.pi/`, `outputs/`) + commit existing docs —
   the writer work must have a VCS safety net (explore risk 4).
2. `npm i -D vitest typebox@1.3.7 @earendil-works/pi-coding-agent` + `vitest.config.ts` +
   `tsconfig.json` + one deliberately failing smoke test → red → green.
3. Only then the first module test. `@earendil-works/pi-coding-agent` is also an optional
   peer dependency (gentle-pi's pattern), never a runtime dependency.

## Data Flow — one `add`

```
/local-models add localhost:11234
  index.ts (shell)
   ├─ detect.normalize()        → http://localhost:11234/v1     (host:port, /v1, /v1/)
   ├─ detect.probe(fetch, 1s)   → 200 + models[]   ·  0 models ⇒ failure
   ├─ ui SelectList: Server kind → mlx-serve   (warn if key ∈ {omlx, mtplx})
   ├─ presets.provider(kind)    → compat block, apiKey "local", headers
   ├─ context.resolve(model)    → value + verificado|declarado|placeholder
   │     /v1/models → /props → llama-swap config.yaml → ui.editor("32768")
   ├─ presets.thinking(model)   → thinkingFormat proposal (SettingsList preview/override)
   ├─ models-writer.commit()
   │     read → comment guard → merge (fill-never-overwrite) → mirror validate
   │     → backup models.json.<epoch>.bak (rotate, cap 10) → write
   │     → verifyWritten()  ⇒ ok ? keep : restore newest backup
   └─ state.save()              → ~/.pi/agent/gentle-local-models.json
  ⇒ modelRegistry.refresh() already ran ⇒ visible in /model and /gentle:models, no restart
```

## File Changes

| File | Action | Description |
|---|---|---|
| `package.json` | Create | npm package, `pi.extensions`, devDeps, `test: vitest run` |
| `.gitignore`, `tsconfig.json`, `vitest.config.ts` | Create | Bootstrap (D8) |
| `extensions/local-models/index.ts` | Create | `registerCommand("local-models")`; `add`/`list`/`prune` shell |
| `extensions/local-models/detect.ts` | Create | URL normalization, 1 s `/v1/models` probe, zero-models = failure |
| `extensions/local-models/presets.ts` | Create | Preset table by Server kind + `thinkingFormat` family heuristic |
| `extensions/local-models/models-writer.ts` | Create | Merge, comment guard, mirror validate, backup rotation, lint, restore |
| `extensions/local-models/state.ts` | Create | `gentle-local-models.json` read/write, ownership, labels, `piVersion` |
| `extensions/local-models/context.ts` | Create | Source priority chain + labeling |
| `extensions/local-models/ui/*.ts` | Create | SelectList / SettingsList / BorderedLoader wrappers, prompts |
| `tests/*.test.ts` | Create | One suite per core module (D9 table) |
| `~/.pi/agent/models.json` | Runtime write | Only Pi file written; backup first |

Never written: `~/.pi/gentle-ai/models.json`, `models.export.json`, `subagents.json` (ADR-0001).

## Interfaces

```ts
type ContextLabel = "verificado" | "declarado" | "placeholder";
type ServerKind = "mtplx" | "omlx" | "mlx-serve" | "llama-swap" | "generic";

interface PluginState {           // ~/.pi/agent/gentle-local-models.json
  version: 1;
  piVersion: string;              // mirror-drift flag
  servers: Array<{
    baseUrl: string;              // normalized, ends in /v1
    kind: ServerKind;
    servingMode: "single-model" | "on-demand";
    providerKey: string;
    owner: "plugin" | "external" | "unknown";
    lastError?: string;
    models: Record<string, { contextLabel: ContextLabel; contextSource: string }>;
  }>;
}

type WriteOutcome =
  | { kind: "written";  backup?: string; lint: string[] }
  | { kind: "refused";  reason: "comments" }
  | { kind: "invalid";  errors: string[]; backups: string[] } // file untouched; backups offered for recovery (D4c)
  | { kind: "restored"; path: string; error: string;       // a backup was restored; `verification`
      verification: { ok: true } | { ok: false; error: string } } // is a SECOND verifyWritten (D3)
  | { kind: "rolled-back"; error: string }                 // no backup existed; rolled back to "no file"
  | { kind: "restore-failed"; path: string; reason: string; error: string } // restore itself failed; failed write left in place
  | { kind: "write-failed"; stage: "read" | "rotate-backups" | "restore";  // an injected port itself
      error: string; fileState: "untouched" | "unverified-write"; backup?: string }; // rejected/threw (C)

interface WriterPorts {           // injected — makes the writer unit-testable
  readFile(p: string): Promise<string | undefined>;
  writeFile(p: string, s: string): Promise<void>;   // MUST be atomic: write-temp + rename (D4)
  deleteFile(p: string): Promise<void>;
  listBackups(p: string): Promise<string[]>;
  now(): number;
  verifyWritten(providerKey: string, modelIds: string[]): Promise<{ ok: true } | { ok: false; error: string }>;
}
```

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | normalization, probe (timeout, zero-models), preset table, heuristic, context chain | vitest + stubbed `fetch`; pure functions, no Pi |
| Unit | merge fill-never-overwrite, comment guard, mirror validate, lint, backup rotation cap 10 | vitest + `WriterPorts` fakes; fixture `models.json` carrying the real `lmstudio` block |
| Integration | full `commit()` against a temp dir | real `fs` under `os.tmpdir()`; asserts backup exists, no field overwritten, restore on `verifyWritten` failure |
| Manual E2E | `add` against mlx-serve `:11234` / llama-swap `:8080`, then `/model` and `pi --list-models` | documented checklist — needs a live Server and Pi runtime, not automated in v0.1 |

## Known limitations

- **Single-read stale window in `commit()`** (PR6 review, R4-003/R1-004): `commit()` reads
  `models.json` once at the start of its orchestration and writes back a merge of that
  snapshot. An external write to `models.json` landing between the read and the write is
  clobbered, and — because the backup rotation only ever captures `commit()`'s OWN read
  snapshot — that external write is not captured in any backup either. Accepted for v0.1:
  the window is millisecond-scale and this is an interactively-invoked, single-user CLI
  command, not a long-running service with concurrent writers. Revisit if a batch/scripted
  mode (multiple concurrent `add`/`prune` invocations) arrives.

## Migration / Rollout

No migration. Runtime rollback = restore newest `models.json.<epoch>.bak` (automatic on
read-back failure). Plugin rollback = delete the extension and `gentle-local-models.json`;
written Providers stay valid without the plugin.

## Open Questions

- [ ] Proposal D4 says the interactive fallback labels `placeholder`; the spec and the user's
  answer say `declarado` (never `verificado`). Design follows spec: prompt ⇒ `declarado`,
  non-interactive omission ⇒ `placeholder`. Confirm in tasks.
- [ ] `prune`'s "local Provider" test is host-based (loopback/private). A local Server reached
  through a LAN hostname would be excluded — acceptable for v0.1, revisit in v0.2.
