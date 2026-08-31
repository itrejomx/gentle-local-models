# Manual End-to-End Checklist

This plugin's shell (`index.ts`, `ports.ts`) touches `ctx` and real network/fs
I/O — the automated suite (`npx vitest run`) covers everything else against
fakes. Run this checklist by hand against a real Pi session before releasing
a change that touches `index.ts` or `ports.ts`.

Prerequisites: the extension is loaded (see `extensions/local-models/README.md`'s
dev loop — symlink + `/reload`), and you have at least one of:

- **mlx-serve** running on `:11234` (Single-Model Server)
- **llama-swap** running on `:8080` (On-Demand Server)

If testing llama-swap's context resolution, confirm `LLAMA_SWAP_CONFIG_PATH`
points at your actual `config.yaml` before starting Pi (see README — the
default is `~/.llama-swap/config.yaml`).

Back up `~/.pi/agent/models.json` and `~/.pi/agent/gentle-local-models.json`
before starting, in case a step misbehaves. `add` and `prune` back them up
automatically too — just don't rely on that alone the first time you run
this checklist.

## 1. `add` — happy path

- [ ] Run `/local-models add localhost:11234` (mlx-serve) or
      `/local-models add localhost:8080` (llama-swap).
- [ ] Select the matching Server kind at the prompt (`mlx-serve` /
      `llama-swap`).
- [ ] Confirm the success notification names the Provider key and model
      count.

## 2. Context-resolution prompt behavior

Exercise this against a model whose `contextWindow` is not yet in
`models.json` (a fresh Provider key, or delete the model's entry first).

- [ ] **Verified source available** (mlx-serve `/v1/models`, or llama-swap
      with a readable `config.yaml`): no prompt appears; the model is
      registered with `contextWindow` set and labeled `verificado` in
      `gentle-local-models.json`.
- [ ] **No source resolves**: an editable prompt appears per model,
      pre-filled with `32768`.
  - [ ] Accept the pre-filled value unedited → registered, labeled
        `declarado`.
  - [ ] Edit it to a different positive integer → that value is used,
        labeled `declarado`.
  - [ ] Type something invalid (letters, `0`, a negative number, or leave it
        empty) → a warning names the model and explains the value was
        rejected; the model is registered anyway with `contextWindow`
        omitted, labeled `placeholder`.
  - [ ] Cancel the prompt (Esc / editor cancel) → same as invalid input:
        `contextWindow` omitted, labeled `placeholder`, no crash.

## 3. Reasoning-confirm behavior

Pick a model whose id matches a known family (`qwen*`, `glm*`, `deepseek*`)
and, separately if available, a Server that declares `capabilities` on
`/v1/models` (mlx-serve does).

- [ ] **Server declares `"reasoning"` in `capabilities`**: no confirm prompt
      — `reasoning: true` is set directly. If the family heuristic also
      proposes a `thinkingFormat`, you get exactly one edit prompt to accept
      or override it.
- [ ] **Family-matched, not declared**: one confirm prompt appears
      ("Model `<id>` looks like a `<family>` reasoning model. Mark
      reasoning + thinkingFormat `<format>`?").
  - [ ] Accept → both `reasoning` and `compat.thinkingFormat` are set; you
        then get one edit prompt to keep or override the format.
  - [ ] Decline → neither `reasoning` nor `thinkingFormat` is set for that
        model.
- [ ] **No family match**: nothing is proposed, no prompt.
- [ ] **Non-interactive** (`pi -e`/scripted invocation with no UI): no
      prompts fire; a single warning names every family-matched-but-unconfirmed
      model instead of guessing.

## 4. Provider visibility

- [ ] Run `/model` — the new Provider and its model(s) appear, with no Pi
      restart.
- [ ] Run `pi --list-models` from a shell — same Provider/models appear
      (confirms the write survived a fresh process, not just the in-memory
      registry refresh).
- [ ] Run `/gentle:models` (gentle-pi's assignment picker) — the new
      Provider is selectable there too. This plugin never writes
      `~/.pi/gentle-ai/models.json`; it only needs to make the Provider show
      up in Pi's own model registry for `/gentle:models` to see it.

## 5. `list` — happy path

- [ ] Run `/local-models list`.
- [ ] Every registered Server (from `models.json` and/or plugin state)
      appears, each with reachability, owner, and model count.
- [ ] Stop one Server's process, run `list` again → that row shows
      "not detected" with a specific error, not a generic failure.
- [ ] Restart the Server, run `list` again → it reports reachable again.
- [ ] Note: `list`'s output does not show `servingMode` — that value is
      inferred (a length-based heuristic; see README) and currently only
      lives in `gentle-local-models.json`, not rendered in `list`'s output
      in v0.1.

## 6. `prune` — happy path

Prerequisite: a Server has stopped reporting a model that is still
registered (stop the model on the Server, or edit `models.json` by hand to
add a model id the Server doesn't serve — only for this manual test, then
restore your backup after).

- [ ] Run `/local-models prune`.
- [ ] Exactly one confirmation prompt covers every candidate across every
      local Provider — not one prompt per Provider or per model.
- [ ] The prompt lists each candidate Provider with its ownership label
      (`plugin` / `external` / `unknown`) and the specific model ids that
      would be removed.
- [ ] Confirm → the Unserved Models are removed; the success message names
      how many models and how many Providers were affected.
- [ ] Cancel → nothing changes; a "Prune cancelled." notification appears.
- [ ] A Provider whose Server is unreachable during the `prune` probe is
      skipped entirely (not treated as "reports zero models") — confirm the
      warning names it and that none of its models were offered for
      removal.
- [ ] Try registering (by hand, in `models.json`) a Provider whose `baseUrl`
      is a LAN hostname rather than `localhost`/`127.0.0.1` — confirm
      `prune` does not reach it (known v0.1 scope limit, see README).

## 7. Backups

- [ ] After any successful `add` or `prune` write, list the directory next
      to `models.json`:

  ```bash
  ls -la ~/.pi/agent/models.json*
  ```

- [ ] A new `models.json.<epoch>.bak` file appears next to `models.json`
      for every write.
- [ ] After 11+ plugin writes, confirm no more than 10 `.bak` files exist
      (oldest rotates out).
- [ ] Diff a `.bak` against the current `models.json` — only the fields the
      operation you just ran should have touched are different; no
      unrelated Provider or field changed.

## 8. Scope check

- [ ] After the whole run above, confirm nothing outside these two files
      (plus rotating backups) was ever written:
  - `~/.pi/agent/models.json`
  - `~/.pi/agent/gentle-local-models.json`
- [ ] In particular, confirm `~/.pi/gentle-ai/models.json`,
      `models.export.json`, and `subagents.json` are all untouched
      (ADR-0001; compare mtimes before/after).
