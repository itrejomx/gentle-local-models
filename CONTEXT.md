# gentle-local-models

Glossary for the Pi plugin that registers local model servers in Pi and assigns models to SDD phases. Definitions only — no implementation details.

## Language

**Server**:
A running process that exposes an OpenAI-compatible HTTP API at a base URL and serves one or more models (today: mtplx, omlx, mlx-serve, llama-swap).
_Avoid_: runtime, backend, host, endpoint

**Provider**:
Pi's registration of a Server: the base URL, credentials, compatibility flags and the list of models Pi may use from it. One Server is registered as exactly one Provider.
_Avoid_: server (when meaning the registration), connection, config

**Routable Agent**:
A named gentle-pi agent that can be given its own model and thinking level — the twelve `sdd-*` agents and the three judgment-day agents. This is what the PRD called a "phase".
_Avoid_: phase, stage, step

**Routing**:
gentle-pi's assignment of a model (and thinking level) to each Routable Agent. Owned by gentle-pi; this plugin reads it and never writes it.
_Avoid_: mapping, assignment, profile

**Check**:
The plugin's validation of the current Routing: for every Routable Agent pointed at a local Provider, confirm the model can do what that agent needs and warn otherwise.
_Avoid_: probe (a Check runs probes; it is not one), lint, audit

**Unserved Model**:
A model listed in a Provider that its Server no longer reports. It stays registered until the user explicitly prunes it.
_Avoid_: stale, orphan, missing, dead

**Serving Mode**:
How a Server makes its models available. A **Single-Model Server** serves exactly one model per process and lists only that one (mtplx; a second model means a second process on another port, i.e. a second Server). An **On-Demand Server** lists every model it could serve and loads one when first requested, evicting others as memory requires (llama-swap, oMLX).
_Avoid_: static/dynamic, hot/cold, swap server
