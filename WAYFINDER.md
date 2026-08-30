# Wayfinder

## What this repo is

Planning repository for `gentle-local-models`, a Pi plugin that registers local OpenAI-compatible model servers as Pi providers and validates the per-agent model routing that gentle-pi saves. The plugin registers and validates; it never assigns models to agents (see ADR-0001). There is no code yet — the repo holds the glossary, the architectural decision, and the PRD.

Reading order:

1. [`CONTEXT.md`](./CONTEXT.md) — the glossary. Every capitalised term below (Server, Provider, Routable Agent, Routing, Check, Unserved Model, Serving Mode) is defined there.
2. [`docs/adr/0001-register-and-validate-never-assign.md`](./docs/adr/0001-register-and-validate-never-assign.md) — why the plugin has exactly two responsibilities.
3. [`01-plugin-modelos-locales-pi.md`](./01-plugin-modelos-locales-pi.md) — the PRD (Spanish), with requirements, verified technical context, and delivery cut.
4. This file — where things live and how to check them by hand.

## Files the plugin touches

| Path | Owner | Plugin access | Notes |
|---|---|---|---|
| `~/.pi/agent/models.json` | Pi / user | Write, fill-never-overwrite | Providers and models Pi can use. Also rewritten wholesale (per provider key) by `omlx launch pi` (`providers.omlx`) and `mtplx start pi` (`providers.mtplx`). Validated by Pi with TypeBox; one bad field disables every provider. Pi strips JSON comments on read, so the plugin refuses to write when comments are present. Backup before every write. |
| `~/.pi/agent/gentle-local-models.json` | Plugin | Read / write | Plugin state: registered Servers (URL, kind, Serving Mode), which Providers the plugin created, context labels (verified / declared / placeholder), probe cache with timestamps. |
| `~/.pi/gentle-ai/models.json` | gentle-pi | Read-only | The Routing: flat map `{ "<agent>": { "model": "provider/id", "thinking": "<level>" } }`. Global, not per project. Never written by the plugin. |
| `~/.pi/gentle-ai/models.export.json` | gentle-pi | Read-only | Team export envelope (`kind: "gentle-pi.agent_model_routing"`, `version: 1`). The plugin validates it with `check <file>`; restoring it is done in `/gentle:models`. |
| `~/.pi/agent/subagents.json`, `<cwd>/.pi/subagents.json` | gentle-pi | Never touched | Where gentle-pi applies the Routing (`model_profiles`, key `effort`). |
| `~/.pi/agent/settings.json` | Pi | Never touched | `omlx launch pi` rewrites `defaultProvider` / `defaultModel` here. |
| `~/Code/llama-swap-config/config.yaml` | User | Read-only | Source of truth for llama-swap context: `--ctx-size` per model. |

## Commands

Plugin:

| Command | Purpose |
|---|---|
| `/local-models add <baseUrl>` | Register a Server by explicit URL; pick its kind (mtplx, omlx, mlx-serve, llama-swap, generic); write or fill the Provider. |
| `/local-models list` | Show registered Servers, their models, context labels, and Unserved Models. |
| `/local-models prune` | Remove Unserved Models after confirmation. |
| `/local-models check [export-file] [--fresh]` | Validate the Routing (or an export file) against Servers: context thresholds, invalid keys, foreign-writer warnings, Serving Mode rules, tool-calling probes. `--fresh` ignores the probe cache. |

External commands the user runs:

| Command | Owner | Purpose |
|---|---|---|
| `/gentle:models` | gentle-pi | Assign models and thinking levels to agents; row 0 is "Set all agents"; `x` exports, `r` restores. |
| `/model` | Pi | Pick the active model; re-reads `models.json` on open. |
| `/reload` | Pi | Reload extensions during local development. |

## The 15 Routable Agents

`sdd-init`, `sdd-onboard`, `sdd-explore`, `sdd-proposal`, `sdd-spec`, `sdd-design`, `sdd-tasks`, `sdd-status`, `sdd-apply`, `sdd-verify`, `sdd-sync`, `sdd-archive`, `jd-judge-a`, `jd-judge-b`, `jd-fix-agent`.

Notes:

- The agent is `sdd-proposal`, not `propose`. `sdd-sync` is a real phase between verify and archive.
- `review` is not a phase. `review-risk`, `review-resilience`, `review-readability`, `review-reliability` are a separate agent family outside the core list.
- Agents that run concurrently and must share a model on an On-Demand Server (or live on different Servers): `jd-judge-a` + `jd-judge-b`; the four `review-*` lenses.

## Where to look in external code

| Topic | Location |
|---|---|
| gentle-pi command registration | `~/.pi/agent/npm/node_modules/gentle-pi/extensions/gentle-ai.ts:7676` |
| gentle-pi forbidden command names | `.../gentle-pi/tests/runtime-harness.mjs:47-62` |
| gentle-pi Routing path (global) | `.../gentle-pi/extensions/gentle-ai.ts:1122-1128`; legacy project fallback `:1244-1250` |
| gentle-pi Routing types and validation | `.../gentle-pi/extensions/gentle-ai.ts:928-946`, `:1186`, `:1196-1208`, `:1276-1285` |
| gentle-pi export envelope | `.../gentle-pi/extensions/gentle-ai.ts:1130-1135`, `:1301-1315` |
| gentle-pi apply on session start | `.../gentle-pi/extensions/gentle-ai.ts:7396-7399`; apply logic `:1713-1793` |
| gentle-pi model list source | `.../gentle-pi/extensions/gentle-ai.ts:1817-1824` (`ctx.modelRegistry.getAvailable()`) |
| gentle-pi core agent names | `.../gentle-pi/extensions/gentle-ai.ts:900-926` |
| gentle-pi per-phase recommendations | `.../gentle-pi/README.md:556-565`; `.../gentle-pi/assets/sdd-orchestrator-workflow.md:237-251` |
| Pi compaction threshold | `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js:160-163` |
| Pi contextWindow default | `.../pi-coding-agent/dist/core/provider-composer.js:72` |
| Pi models.json schema and loader | `.../pi-coding-agent/dist/core/model-config.js:181-250`; types `.../dist/core/model-config.d.ts:37-52` |
| Pi built-in llama.cpp provider | `.../pi-coding-agent/dist/extensions/llama/provider.js` |
| oMLX models listing | `/Applications/oMLX.app/Contents/Resources/omlx/server.py:2732`; response schema `.../omlx/api/openai_models.py:465` |
| oMLX engine pool (LRU, on-demand) | `.../omlx/engine_pool.py` |
| oMLX context discovery | `.../omlx/model_discovery.py:848-898`; policy `.../omlx/settings.py:693-728` |
| oMLX Pi writer | `.../omlx/integrations/pi.py` |
| mtplx models listing | `~/Library/Application Support/MTPLX/runtime-venv/lib/python3.14/site-packages/mtplx/server/openai.py:25514` |
| mtplx context at startup | `.../mtplx/server/openai.py:2247-2270`; backend descriptor `:1361-1367` |
| mtplx Pi writer | `.../mtplx/pi.py:177-262` |
| llama-swap config | `~/Code/llama-swap-config/config.yaml` |

## How to verify things by hand

llama-swap (running on `:8080`):

```sh
curl -s http://localhost:8080/v1/models | jq '.data[] | {id, status}'
curl -s http://localhost:8080/running
rg -n "^  [A-Za-z0-9._-]+:$|--ctx-size" ~/Code/llama-swap-config/config.yaml
```

oMLX (replace the port with the one it is serving on):

```sh
curl -s http://localhost:<port>/v1/models | jq '.data[] | {id, max_model_len}'
curl -s http://localhost:<port>/v1/models/status
```

mtplx (one daemon per port):

```sh
curl -s http://localhost:<port>/v1/models | jq '.data[] | {id, context_length, max_model_len}'
curl -s http://localhost:<port>/health | jq '{ok, model, mode: .generation_mode}'   # full backend descriptor
mtplx settings get --port <port> --json | jq '.context_window_policy'               # configured vs maximum window (no HTTP /settings)
```

mlx-serve (`MLX Core.app`, one model per process; `:11234` in the last session):

```sh
ps -o command= -p "$(pgrep -f 'MLX Core.app/Contents/MacOS/mlx-serve')"   # shows --model and --ctx-size
curl -s http://localhost:11234/v1/models | jq '.data[] | {id, loaded, state, capabilities, context: .meta.context_length}'
curl -s http://localhost:11234/props | jq '{n_ctx: .default_generation_settings.n_ctx, max_safe_context: .memory.max_safe_context}'
```

Minimal tool-calling probe (any OpenAI-compatible Server; loads the model on an On-Demand Server):

```sh
curl -s http://localhost:<port>/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "<id>", "max_tokens": 64, "temperature": 0,
  "messages": [{"role":"user","content":"Call the tool get_time with timezone \"UTC\". Do not answer in prose."}],
  "tools": [{"type":"function","function":{"name":"get_time","description":"Get the current time",
    "parameters":{"type":"object","properties":{"timezone":{"type":"string"}},"required":["timezone"]}}}]
}' | jq '.choices[0] | {finish_reason, tool_calls: .message.tool_calls}'
```

gentle-pi Routing:

```sh
jq 'keys' ~/.pi/gentle-ai/models.json
jq 'to_entries | map(select(.key | startswith("sdd-") or startswith("jd-")))' ~/.pi/gentle-ai/models.json
```

Pi providers currently registered:

```sh
jq '.providers | to_entries[] | {key, baseUrl: .value.baseUrl, models: (.value.models | map(.id))}' ~/.pi/agent/models.json
```

## Servers in use today

| Server | Serving Mode | Context by API | Notes |
|---|---|---|---|
| mtplx | Single-Model Server | Yes (`context_length`, `max_model_len` in `/v1/models`; `context_window_policy` default/maximum via `mtplx settings get`) | One model per daemon; the team runs several daemons (ports 8000, 8008, 8010). Each port is a separate Server and Provider. `/health` carries the full backend descriptor. Tool-calling probe verified. |
| oMLX | On-Demand Server | Yes (`max_model_len` in `/v1/models`, `/v1/models/status`) | Lists all discovered models; LRU eviction under a memory guard; one concurrent request. |
| mlx-serve (`MLX Core.app`) | Single-Model Server | Yes (`meta.context_length` in `/v1/models`; `/props` with `n_ctx` and dynamic `memory.max_safe_context`) | Verified live on `:11234`. One `--model` per process with `--ctx-size` on the command line. Declares `capabilities` (`tool_use`, `reasoning`, `json_schema`, ...). Also serves Ollama-style `/api/tags`. Tool-calling probe returned valid `tool_calls`. |
| llama-swap | On-Demand Server | No | Running on `:8080`; `--parallel 1`; context truth in `config.yaml`. |

Also present in `~/.pi/agent/models.json` today: a provider `lmstudio` on `localhost:1234` with 17 hand-curated models, all declaring `contextWindow: 262144`.

## Memory

Session decisions and discoveries are saved in Engram under `pi-local-models/*` topic keys:

- `pi-local-models/scope/server-contract`
- `pi-local-models/scope/detection`
- `pi-local-models/adr/0001-register-and-validate`
- `pi-local-models/scope/profiles`
- `pi-local-models/writer/merge-policy`
- `pi-local-models/compat/presets`
- `pi-local-models/check/swap-and-single-model-rules`
- `pi-local-models/check/probe-policy`
- `pi-local-models/writer/state-file-and-guards`
- `pi-local-models/scope/command-namespace`
- `pi-local-models/research/*` (gentle-pi routing, Pi context window and llama provider, server context exposure, serving modes, Pi models.json validation)
