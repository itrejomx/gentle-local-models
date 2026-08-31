# local-models

A Pi extension that registers local OpenAI-compatible model Servers (mlx-serve,
llama-swap, mtplx, omlx, or anything generic) as Pi Providers, without hand-editing
`models.json`.

```
/local-models                  open a menu: Add a Server… / List Servers / Prune Unserved Models
/local-models add [baseUrl]    register a Server; with no baseUrl, prompts for one (prefilled http://localhost:)
/local-models list             probe every known Server, show reachability
/local-models prune            remove models a Server no longer reports (one confirmation, one backup)
```

### Bare `/local-models` opens a menu (v0.1.2)

Running `/local-models` with no subcommand and a dialog-capable UI opens a
menu — "Add a Server…", "List Servers", "Prune Unserved Models" — routing to
the same add/list/prune flows below. Cancelling the menu (Esc) returns
quietly, no notification. Without a dialog-capable UI (non-interactive run),
the bare command falls back to the usage notice instead of opening a dialog.

Picking "Add a Server…", or typing `/local-models add` with no URL, prompts
(titled "Server base URL (e.g. http://localhost:8080)") for the Server's
base URL via an editable prefill (`http://localhost:`) — edit it to the
real host:port and submit. Cancelling, or submitting empty text, is a quiet
"Registration cancelled." (matching the Server-kind picker's own cancel
copy) — nothing is probed or written. Submitting without an explicit port
(e.g. accepting the prefill unedited) reports "Include the port, e.g.
http://localhost:8080" and does not probe. A submitted value with a port
continues into the normal `add` flow below (host:port, a trailing `/v1`, or
`/v1/` all normalize the same way; an unparsable URL gets the same friendly
error as typing it directly).

## Dev loop

No build step: Pi loads `.ts` extensions directly through `jiti`, so edits take
effect on the next reload.

1. Symlink this directory into your Pi project's local extensions folder:

   ```bash
   mkdir -p .pi/extensions
   ln -s "$(pwd)/extensions/local-models" .pi/extensions/local-models
   ```

   Pi auto-discovers `.pi/extensions/*/index.ts` (project-local, subdirectory form).

2. Start or reload Pi, then run `/reload` after every edit to pick up changes
   without restarting the session.

3. Run the automated suite before every reload if you touched a core module
   (`detect.ts`, `presets.ts`, `context.ts`, `state.ts`, `models-writer.ts`):

   ```bash
   npx vitest run
   npx tsc --noEmit
   ```

   These modules are pure — no `ctx` import — so they run under vitest with
   zero Pi runtime. Only `index.ts` and `ports.ts` touch `ctx` or real I/O;
   changes there need a manual `/local-models add|list|prune` pass against a
   live Server too (see `tests/MANUAL-E2E.md`).

### The `pi.extensions` manifest

`package.json` declares:

```json
{ "pi": { "extensions": ["./extensions"] } }
```

This is the same manifest key Pi packages use (`docs/packages.md`): it tells
Pi "load every extension entry point under this directory" when this repo is
installed as a package (`pi install git:...` / `pi install npm:...`). Locally,
during development, the manifest is inert — the `.pi/extensions/local-models`
symlink above is what makes Pi discover the extension in a working session.
Both paths resolve to the same `extensions/local-models/index.ts` entry point.

## Known v0.1 limitations (read before debugging)

### Server kind is auto-detected but still a real choice (v0.1.1)

`add` preselects the Server-kind picker from `/v1/models`' `owned_by` field
(`llama-swap`, `mtplx`, `mlx-serve`, `omlx` map to their matching kind;
anything else — including a missing `owned_by` — falls back to `generic`,
shown first in the list). The picker still opens and any kind can be picked
instead; cancelling aborts registration exactly as before.

### Context-window and reasoning prompts are batched per `add` run (v0.1.1)

Registering a Server with many models used to prompt once per model for both
`contextWindow` and reasoning confirmation — on a 25-model Server that meant
dozens of dialogs in a row. As of v0.1.1:

- **contextWindow**: every model still gets resolved from the same source
  chain first (`verificado`, unchanged). If any are left unresolved, ONE
  picker appears — `32k`, `64k`, `128k`, `192k`, `256k`, or `Custom…`
  (prefilled `32768`, editable) — and the chosen value applies to every
  unresolved model, labeled `declarado`. Cancelling, or an invalid `Custom…`
  answer, falls back to `placeholder` for all of them (same as before).
- **reasoning**: a Server-declared capability is still verified directly, no
  prompt. A model id containing `nothink` (case-insensitive) is now
  auto-declined — no prompt, reported in its own notice — since it explicitly
  signals a non-thinking variant. Every remaining family-matched model is
  offered in ONE confirm ("Mark N models as reasoning models with
  thinkingFormat per family? ..."); accepting sets `reasoning` and
  `thinkingFormat` on all of them, declining sets neither on any of them.

**Removed in this batching**: the per-model `thinkingFormat` override editor
that used to follow each individual reasoning confirm. In v0.1.1 there is no
way to pick a `thinkingFormat` other than the family heuristic through
`add` — accept applies the heuristic to every candidate, decline applies it
to none. To use a different value today, edit `models.json` by hand after
registration (fill-never-overwrite will never touch it again once set). A
v0.2 refinement is planned to reintroduce a per-model override, most likely
via a targeted re-add of a single model.

### A Provider missing `api` gets it filled, new or existing (v0.1.1)

Pi's provider composer requires `api` (e.g. `"openai-completions"`) at the
Provider level or on every one of its models to resolve requests; a Provider
missing it entirely makes Pi report a composition error for the whole
registry. `add` fills `api: "openai-completions"` onto the Provider-level
field whenever it is absent — whether the Provider is brand new or one this
plugin (or you, by hand) already wrote without it — self-healing that
Provider the next time you re-run `add` against it. An existing Provider
that already carries `api` (any value) is never touched, per
fill-never-overwrite.

### `LLAMA_SWAP_CONFIG_PATH`

`context.ts`'s third context-resolution source reads llama-swap's own
`config.yaml` for `--ctx-size`. The real port (`ports.ts`'s
`realContextPorts()`) defaults to:

```
~/.llama-swap/config.yaml
```

If your llama-swap config lives anywhere else (for example
`~/Code/llama-swap-config/config.yaml`), **you must set the environment
variable** before running Pi, or this source silently never resolves and
`add` falls through to the interactive prompt / `placeholder` label instead:

```bash
export LLAMA_SWAP_CONFIG_PATH=~/Code/llama-swap-config/config.yaml
```

A missing or unreadable file at the resolved path is not an error — it just
means this source contributes nothing (v0.1 has no live discovery of a
running llama-swap instance's actual config path; that is v0.2/R5 territory).

### `servingMode` is inferred, not confirmed

`add` derives `servingMode` with a length-based heuristic and stores it in
`gentle-local-models.json`:

- probe reports **one** model → `single-model`
- probe reports **more than one** model → `on-demand`

This is a proxy for "how many models can this Server serve concurrently",
not a fact read from the Server itself. A multi-model-capable Server that
happens to have only one model loaded at probe time will be misclassified as
`single-model`. Treat any `servingMode` value in state as a hint, not ground
truth, until v0.2's Check firms this up with a real per-kind contract.

### `capabilities` is an additive positive signal only

When a Server declares `capabilities` on `/v1/models` (mlx-serve does this,
e.g. `["chat", "tool_use", "streaming", "reasoning", ...]`), `add` treats
`"reasoning"` in that list as verified — no confirmation prompt, `reasoning`
is set directly. But the **absence** of `"reasoning"` from a declared
`capabilities` list proves nothing: the model still gets the normal
family-heuristic confirmation step. Do not read a missing capability as "this
Server confirms this model can't do X" — only a *present* capability is
meaningful.

### Diagnosing an oversized declared `contextWindow`

Every registered model's `contextWindow` carries one of three labels,
visible in `gentle-local-models.json`:

| Label | Meaning |
|---|---|
| `verificado` | Read from the Server's own ground truth: `/v1/models`, `/props`, or the `config.yaml` that launched it. |
| `declarado` | Chosen by you at the batched interactive prompt: one of the presets (`32k`/`64k`/`128k`/`192k`/`256k`) or `Custom…` (opens an editor pre-filled with `32768`, editable). |
| `placeholder` | No source resolved and no prompt was possible (non-interactive run) — `contextWindow` was omitted entirely. |

If a model's *declared* `contextWindow` is larger than what the Server can
actually sustain, symptoms tend to show up mid-session rather than at
registration time: tools stop working partway through a task, the agent
loops without making progress, or responses get cut off mid-sentence. When
you see any of these, check the model's label first:

- `verificado` misbehaving → the Server itself may be under-provisioned for
  the context size it reports; this is a Server-side problem, not a labeling
  bug.
- `declarado` or `placeholder` misbehaving → re-run `/local-models add` and
  answer the prompt with a smaller, evidence-based number, or let a
  `verificado` source resolve it (e.g. set `LLAMA_SWAP_CONFIG_PATH` above).

### `prune`'s "local Provider" scope is hostname-based

`prune` reaches every Provider whose `baseUrl` host is `localhost`,
`127.0.0.1`, `0.0.0.0`, or `::1` (`detect.isLocalHost`) — including ones this
plugin never wrote. A local Server reached through a LAN hostname (e.g.
`http://my-mac.local:11234`) is out of `prune`'s scope in v0.1; this is a
known, accepted gap (see `openspec/changes/v0.1-registrar/design.md`, Open
Questions).
