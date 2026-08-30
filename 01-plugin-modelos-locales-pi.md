# 01 — PRD: Plugin de modelos locales para Pi (`gentle-local-models`)

**Nombre:** `gentle-local-models` (paquete npm, `pi install npm:gentle-local-models`)
**Comando:** `/local-models` (sin prefijo `gentle:`; ver §8 y decisión de namespace)
**Estado:** Revisado (sesión de grill, 2026-08-29)

Documentos relacionados:
- Glosario: [`CONTEXT.md`](./CONTEXT.md)
- Decisión arquitectónica: [`docs/adr/0001-register-and-validate-never-assign.md`](./docs/adr/0001-register-and-validate-never-assign.md)
- Navegación: [`WAYFINDER.md`](./WAYFINDER.md)

Los términos en mayúscula inicial (Server, Provider, Routable Agent, Routing, Check, Unserved Model, Serving Mode) están definidos en `CONTEXT.md` y se usan aquí con ese significado exacto.

---

## 1. Problem statement

El equipo corre modelos locales detrás de cuatro Servers OpenAI-compatible (mtplx, oMLX, mlx-serve, llama-swap) y los rutea a las fases SDD con gentle-pi. Hoy esa combinación falla de cuatro formas que nadie detecta hasta la mitad de un ciclo:

1. **`contextWindow` es una declaración que Pi cree a ciegas.** Pi usa el valor de `~/.pi/agent/models.json` para decidir cuándo compactar (`tokens > contextWindow - 16384`) y nunca le pregunta al Server cuál es el límite real. El `models.json` actual declara 262144 para casi todos los modelos, mientras que la configuración de llama-swap carga modelos con 98304, 131072, 202752 y 262144. Cuando el declarado supera al real, Pi no compacta a tiempo, el Server rechaza la request y Pi recién lo detecta después del fallo.
2. **Tres escritores del mismo archivo.** Además del usuario (o de este plugin), `omlx launch pi` reemplaza el bloque `providers.omlx` entero y reescribe `settings.json`; `mtplx start pi` reemplaza `providers.mtplx` byte a byte e instala una extensión propia en `~/.pi/agent/extensions/`. Cualquier campo completado a mano en esas claves puede desaparecer.
3. **El Serving Mode se ignora.** llama-swap y oMLX cargan modelos bajo demanda con un solo slot de inferencia (`--parallel 1`, `max_concurrent_requests: 1`). Si dos agentes que corren en paralelo (jd-judge-a y jd-judge-b, o las cuatro lentes `review-*`) tienen modelos distintos en el mismo Server, se desalojan mutuamente en cada request. mtplx sirve un solo modelo por daemon: asignar dos modelos exige dos daemons en dos puertos.
4. **Ya existe un asignador.** `/gentle:models` de gentle-pi lista los providers locales a través del registro de modelos de Pi. Un segundo flujo de asignación duplicaría ese picker y competiría por la propiedad de un archivo sin API de escritura.

El costo de no resolverlo: ciclos SDD rotos por contexto insuficiente o por swaps en cascada, pérdida silenciosa de configuración curada, y fricción para que un dev nuevo registre un Server sin editar JSON.

## 2. Contexto técnico verificado

Todo lo siguiente fue leído en código instalado localmente (gentle-pi 2.2.0, Pi 0.84.x, oMLX.app, mtplx 2.8.2, llama-swap) o probado contra Servers corriendo.

### gentle-pi (`~/.pi/agent/npm/node_modules/gentle-pi/`)

- El comando es **`/gentle:models`** (`extensions/gentle-ai.ts:7676`). `gentleman:models` y `gentle-ai:models` están explícitamente prohibidos en `tests/runtime-harness.mjs:47-62`.
- El archivo de Routing es **global**: `~/.pi/gentle-ai/models.json` (`gentleAiConfigHome`, `modelConfigPath` en :1122-1128). El `.pi/gentle-ai/models.json` de proyecto es un fallback legacy de solo lectura (:1244-1250) y nunca se escribe.
- Schema: mapa plano `{ "<agente>": { "model": "provider/id", "thinking": "off|minimal|low|medium|high|xhigh|max" } }` (:928-946). Sin versión ni `$schema`. Claves o ids fuera de `/^[A-Za-z0-9._~:@/+%-]+$/` se descartan en silencio. `writeModelConfig` es privada; `package.json` no declara `exports`. Solo `models.export.json` tiene envelope versionado (`kind: "gentle-pi.agent_model_routing"`, `version: 1`, :1134-1135).
- Aplicación: en `session_start` (:7396-7399) el Routing se vuelca a `subagents.json` → `model_profiles` (clave `thinking` renombrada a `effort`, :1548-1556; proyecto → `<cwd>/.pi/subagents.json`, usuario y built-in → `~/.pi/agent/subagents.json`) y al frontmatter `model:`/`thinking:` de los agentes no built-in (:1334-1360). `.pi/settings.json` solo se toca para borrar `subagents.agentOverrides` legacy.
- Lista de modelos del picker: `ctx.modelRegistry.getAvailable()` (:1818), que ya incluye los providers custom de `~/.pi/agent/models.json`. Es un snapshot filtrado por disponibilidad: un provider inalcanzable desaparece sin error.
- **15 Routable Agents** (`CORE_MODEL_AGENT_NAMES`, :900-926): `sdd-init`, `sdd-onboard`, `sdd-explore`, `sdd-proposal`, `sdd-spec`, `sdd-design`, `sdd-tasks`, `sdd-status`, `sdd-apply`, `sdd-verify`, `sdd-sync`, `sdd-archive`, `jd-judge-a`, `jd-judge-b`, `jd-fix-agent`. Es `sdd-proposal`, no `propose`. `review` no es una fase: `review-risk`, `review-resilience`, `review-readability`, `review-reliability` son una familia de agentes fuera de la lista core.
- Las recomendaciones por fase difieren entre `README.md:556-565` (proposal: rápido y barato) y `assets/sdd-orchestrator-workflow.md:237-251` (sdd-proposal: deep-reasoning).
- El `~/.pi/gentle-ai/models.json` actual tiene 517 entradas, todas `lmstudio/glm-4.7-flash`, incluidas claves basura como `{module-code-or-empty}{skill-name}` filtradas por "Set all agents".

### Pi (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/`)

- `contextWindow` se usa en `core/compaction/compaction.js:160-163` (`shouldCompact = contextTokens > contextWindow - reserveTokens`, `reserveTokens` = 16384) y en el presupuesto de branch summaries. Default 128000 si falta (`core/provider-composer.js:72`).
- `models.json` se valida con TypeBox en `core/model-config.js:181-250`. Un error en cualquier campo devuelve un mapa de providers **vacío**: todos los providers custom desaparecen a la vez. El archivo se lee con `stripJsonComments`, por lo que puede contener comentarios que un writer ingenuo borraría.
- Schema `compat` en `core/model-config.d.ts:37-52`. Valores de `thinkingFormat`: `openai`, `openrouter`, `together`, `baseten`, `deepseek`, `zai`, `qwen`, `chat-template`, `qwen-chat-template`, `string-thinking`, `ant-ling`. `compat` se acepta a nivel provider y a nivel modelo.
- Pi trae un provider built-in `llama.cpp` (`extensions/llama/provider.js`) que lee `meta.n_ctx` del catálogo del server; llama-swap no devuelve ese campo, así que caería al default de 128000.

### Servers

- **llama-swap** (corriendo en `localhost:8080`, config en `~/Code/llama-swap-config/config.yaml`): `/v1/models` lista todos los modelos configurados con `status.value` pero sin contexto estructurado (solo `description` en texto libre); `/props` responde 404 hasta que hay un modelo cargado; `/running` lista los cargados. La verdad del contexto es `--ctx-size` por modelo en `config.yaml`.
- **oMLX** (`/Applications/oMLX.app/Contents/Resources/omlx/`): `/v1/models` devuelve `max_model_len` por modelo (`api/openai_models.py:465`) y lista todos los descubiertos, cargados o no (`server.py:2732`); `/v1/models/status` expone `max_context_window`. Engine pool multi-modelo con desalojo LRU y memory guard (`engine_pool.py`). `omlx launch pi` reemplaza `providers.omlx` con un provider de un solo modelo, sin `compat`, y reescribe `defaultProvider`/`defaultModel` en `settings.json` (`integrations/pi.py`).
- **mtplx** (venv en `~/Library/Application Support/MTPLX/runtime-venv/`): `/v1/models` lista **un solo** modelo con `context_length`, `max_context_length` y `max_model_len` iguales a la ventana configurada al arrancar (`server/openai.py:25514`). Un modelo por daemon; el equipo corre varios daemons (puertos 8000, 8008, 8010). Verificado en vivo en `:8008`: `/health` es el endpoint del descriptor de backend (modelo, `model_path`, capacidades del runtime, `reasoning_codec` con `effort_levels`), y `mtplx settings get --port <p> --json` (CLI; no hay endpoint HTTP `/settings`) expone `context_window_policy` con `default`, `maximum` y `minimum` — distingue ventana configurada de máxima. Probe de tool calling verificado: `tool_calls` válidos con `finish_reason: "tool_calls"`. `mtplx start pi` reemplaza `providers.mtplx` byte a byte con `compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" }` e instala una extensión de Pi propia (`mtplx/pi.py:242-262`).
- **mlx-serve** (`MLX Core.app`, `com.dalcu.mlx-core`; verificado en vivo en `localhost:11234`): Single-Model Server, un `--model` por proceso con `--ctx-size` en la línea de comando. `/v1/models` lista ese único modelo con `loaded`, `state`, `capabilities` (`chat`, `tool_use`, `streaming`, `reasoning`, `json_schema`), `input_modalities`, `bytes_resident` y `meta.context_length` / `meta.model_max_tokens`. `/props` es compatible con llama.cpp (`default_generation_settings.n_ctx`, `model_info.max_position_embeddings`) y agrega `memory.max_safe_context`, un límite dinámico calculado según la memoria disponible (131072 configurado vs 65159 seguro en la prueba). `/api/tags` es compatible con Ollama. No existe `/v1/models/status`. Probe de tool calling verificado: devuelve `tool_calls` válidos con `finish_reason: "tool_calls"` en 2.2 s con el modelo cargado.

## 3. Goals

1. Registrar un Server local en Pi en **menos de 2 minutos sin editar JSON**, de modo que aparezca en `/model` y en `/gentle:models`.
2. Validar el Routing que gentle-pi guardó contra las capacidades reales de cada modelo: contexto, tool calling y Serving Mode.
3. Cero regresiones sobre los archivos de gentle-pi, garantizado por construcción: el plugin nunca los escribe.
4. Validar un export de Routing del equipo antes de que alguien lo restaure.

## 4. Non-goals

- No asignar modelos a Routable Agents (ADR-0001). Eso es de `/gentle:models`.
- No perfiles nombrados. El intercambio de Routing es responsabilidad de gentle-pi (export/restore).
- No scan de puertos. Un Server nuevo se registra por URL explícita.
- No código específico de Ollama ni vLLM en v1. Ambos caben en el preset genérico.
- No instalar ni administrar runtimes.
- No benchmarkear calidad de modelos; solo probes de capacidad.
- No widget de estado en footer; pertenece al documento 02.
- No servidores remotos con OAuth; solo baseUrl y api key.

## 5. User stories

- Como dev del equipo, quiero registrar llama-swap con `/local-models add http://localhost:8080` y ver sus modelos con su `--ctx-size` real, para no copiar IDs ni adivinar contextos.
- Como dev, quiero que `/local-models check` me avise cuando un modelo asignado a `sdd-apply` declara 262144 de contexto pero el Server lo cargó con 98304, para no perder un ciclo SDD por compactación tardía.
- Como dev, quiero que el Check me advierta si `jd-judge-a` y `jd-judge-b` apuntan a modelos distintos del mismo On-Demand Server, para no desalojarlos mutuamente en paralelo.
- Como dev que corre mtplx, quiero que el Check me indique que ese Server sirve un solo modelo y me guíe a `/gentle:models` → Set all agents o a levantar otro daemon en otro puerto, en lugar de fallar en silencio.
- Como líder técnico, quiero validar `models.export.json` contra los Servers locales con `/local-models check <archivo>` antes de compartirlo, para que el equipo no restaure un Routing que no funciona.

## 6. Requirements

### P0 — Must have

| # | Requisito | Criterios de aceptación |
|---|---|---|
| R1 | Registro por URL | `/local-models add <baseUrl>` y `/local-models list`. La detección prueba `/v1/models` con timeout ≤ 1 s en cada base URL conocida (Providers existentes en `~/.pi/agent/models.json` más los Servers guardados en el estado del plugin). No hay scan de puertos. Un Server inalcanzable se muestra como "no detectado" con el último error. La base URL se normaliza (acepta `host:port`, `.../v1` y `.../v1/`). Una respuesta 200 con cero modelos se trata como fallo, no como éxito (llama-swap con config vacía responde exactamente eso). |
| R2 | Writer seguro de `models.json` | Política "llenar, nunca pisar": modelos nuevos se agregan con `name = id` y defaults conservadores; campos ya presentes (`name`, `contextWindow`, `maxTokens`, `reasoning`, `input`, `compat`) nunca se sobrescriben, solo se completan si faltan. Modelos que el Server ya no reporta se conservan como Unserved Models; borrar requiere `/local-models prune` con confirmación. Cada escritura hace backup previo, valida el resultado contra el schema real de Pi antes de escribir, y se niega a escribir si el archivo contiene comentarios. Como el schema de Pi es permisivo (una clave desconocida en `compat` pasa la validación y no hace nada), el writer además lintea las claves de `compat` contra la lista conocida y advierte ante una desconocida. Los cambios son visibles en `/model` sin reiniciar. |
| R3 | Presets de compat por tipo de Server | Al registrar se elige el tipo: `mtplx`, `omlx`, `mlx-serve`, `llama-swap` o `generic`. Cada tipo aporta un bloque `compat` a nivel Provider tomado de una tabla de datos sembrada con los bloques que hoy funcionan. `thinkingFormat` se propone a nivel modelo por heurística de familia (`qwen*` → `qwen`, `glm*` → `zai`, `deepseek*` → `deepseek`, otro → omitir) solo si `reasoning: true`, se muestra antes de escribir y admite override por modelo. |
| R4 | Contexto real | Fuente por prioridad: `max_model_len`, `context_length` o `meta.context_length` si `/v1/models` lo trae; `default_generation_settings.n_ctx` de `/props` si existe; `--ctx-size` de `config.yaml` para llama-swap; si no, se pregunta al registrar. Si el Server publica un límite dinámico menor (`memory.max_safe_context` en mlx-serve), no reemplaza el `contextWindow` pero el Check lo reporta como advertencia. Cada `contextWindow` queda etiquetado en el estado del plugin como `verificado`, `declarado` o `placeholder`. Nunca se prueba empíricamente. |
| R5 | Check básico | `/local-models check` lee `~/.pi/gentle-ai/models.json` en solo lectura y, para cada uno de los 15 Routable Agents que apunte a un Provider local, valida el umbral de contexto por agente (ver §8), marca claves de Routing inválidas (por ejemplo `{module-code-or-empty}{skill-name}`) y advierte cuando la clave del Provider es una que `omlx launch pi` o `mtplx start pi` reescriben. Hallazgos adicionales del Check: Routing que apunta a un Provider o modelo inexistente; Routing que apunta a un Unserved Model; y deriva de contexto (el valor `verificado` ya no coincide con la fuente, por ejemplo llama-swap relanzado con otro `--ctx-size`). Cada hallazgo indica la fuente del dato de contexto. |

### P1 — Should have

| # | Requisito | Notas |
|---|---|---|
| R6 | Probe de tool calling | Solo dentro de un `check` explícito; nunca en `session_start` ni al registrar. Antes de probar modelos no cargados (llama-swap `status.value`, oMLX `/v1/models/status`) el Check lista qué va a cargar y pide una sola confirmación por corrida. Resultado cacheado por (Server, modelo) con fecha; se reprueba solo con `--fresh` o para modelos nuevos. Timeout de carga en frío 60–120 s, separado del timeout de detección. Si el Server declara la capacidad (`capabilities: ["tool_use"]` en mlx-serve) se muestra como "declarado por el Server", pero no sustituye al probe. |
| R7 | Reglas de Serving Mode | Modelos distintos en Routable Agents secuenciales del mismo On-Demand Server → informativo ("N swaps por ciclo"). Modelos distintos en agentes concurrentes (`jd-judge-a`/`jd-judge-b`, `review-*`) del mismo On-Demand Server → advertencia fuerte. Single-Model Server → mensaje que guía a `/gentle:models` → Set all agents con ese `provider/id`, o a registrar otro daemon en otro puerto como Server aparte. |
| R8 | Validar export del equipo | `/local-models check <archivo>` acepta el envelope de gentle-pi (`kind: "gentle-pi.agent_model_routing"`, `version: 1`) y aplica las mismas reglas que R5–R7 sobre su contenido. El plugin no lo aplica ni lo copia a la ruta de gentle-pi. |

### P2 — Future

- Failover por fase (si el Server local no responde, caer a cloud con confirmación).
- Estimación de VRAM/velocidad antes de asignar.
- PR upstream a gentle-pi con el Check como hook de validación, si el plugin gana tracción.
- Issue upstream en gentle-pi: "Set all agents" barre placeholders de templates como si fueran agentes — publicado como [gentle-pi#510](https://github.com/Gentleman-Programming/gentle-pi/issues/510); el Check del plugin cubre el síntoma mientras tanto.
- Seguir gentle-pi #381 ("expose a machine-readable routing contract", aprobado): cuando ese contrato exista, `routing-reader.ts` debe migrar del archivo crudo al API; hoy el issue mismo confirma que leer el archivo es el único punto de integración.
- Guardia en runtime (extensión aparte): detectar en la respuesta del Server que el modelo no soporta tools y reintentar sin tools, como hace nanocoder (`tool-error-detector.ts`). Fuera del alcance de ADR-0001 (registrar y validar); sería una tercera responsabilidad.
- Heurística tamaño-por-nombre (`4b`, `30b-a3b`) para advertir cuando un modelo ≤ 4B queda asignado a `sdd-apply` o a los judges, sin necesidad de probe.
- Documentar los síntomas de un `contextWindow` declarado mayor que el real (tools que dejan de funcionar, loops, cortes a mitad de frase), al estilo de la doc de Ollama en nanocoder.

Descartado tras revisar nanocoder: timeouts por Server (Pi no tiene campo de timeout por Provider en `models.json`), sonda TCP de 500 ms (`GET /v1/models` con 1 s ya es barato y no carga modelos), y reescritura de framing SSE (transporte de Pi, no del plugin).

## 7. Diseño técnico propuesto

```
gentle-local-models/
  index.ts             # entry: registerCommand("/local-models") con subcomandos add | list | prune | check
  detect.ts            # probe de /v1/models (≤ 1 s) sobre base URLs conocidas; parse de status/max_model_len
  presets.ts           # tabla de datos tipo de Server → bloque compat; heurística de thinkingFormat
  models-writer.ts     # merge "llenar, nunca pisar" + backup + validación contra schema de Pi + guard de comentarios
  state.ts             # ~/.pi/agent/gentle-local-models.json: Servers, tipo, Serving Mode, Providers propios, caché de probes
  context.ts           # fuentes de contexto: max_model_len, config.yaml de llama-swap, input del usuario; etiquetado
  routing-reader.ts    # lector de solo lectura de ~/.pi/gentle-ai/models.json y models.export.json
  check.ts             # reglas R5–R8 sobre Routing + estado + Servers
  probes.ts            # probe de tool calling con confirmación, caché y timeout de carga en frío
  ui/                  # SelectList (picker), SettingsList, BorderedLoader (pi-tui)
```

Decisiones clave:
- **Registrar y validar, nunca asignar** (ADR-0001). No existe `phases.ts`; el Routing es de gentle-pi.
- **Un contrato de Server**: OpenAI-compatible por baseUrl. Las diferencias entre mtplx, oMLX, mlx-serve y llama-swap viven en la tabla de presets y en las fuentes de contexto, no en ramas de código por servidor.
- **Estado propio fuera de `models.json`**, para que ningún dato del plugin pueda invalidar el schema de Pi y apagar todos los providers.
- **Sin daemon**: todo bajo demanda desde el comando. Detección con timeout corto; probes solo bajo confirmación.
- **Distribución**: paquete npm; desarrollo local en `.pi/extensions/` con `/reload`.
- Los términos Server, Provider, Routable Agent, Routing, Check, Unserved Model y Serving Mode se usan tal como los define `CONTEXT.md`.

## 8. Preguntas abiertas

1. **(Producto)** Umbrales de contexto por Routable Agent para R5. Propuesta inicial, a validar con el equipo: `sdd-apply` y `sdd-verify` ≥ 32k; `sdd-design` y `sdd-spec` ≥ 16k; resto ≥ 8k.

Resueltas en la sesión de grill y el spike: formato y ruta del Routing de gentle-pi (§2); `/gentle:models` sí lista providers custom (§2), verificado escribiendo un Provider `mlx-serve` a mano y viéndolo en `pi --list-models` (mismo registry); el filtro de disponibilidad de Pi es por auth resuelta, no por alcanzabilidad (un Provider con apiKey dummy se lista aunque el Server esté caído — por eso el Check existe); mlx-serve verificado en vivo (§2: Single-Model, expone contexto y capacidades, probe de tool calling OK); mtplx verificado en vivo (§2: `/health` como descriptor, `context_window_policy` vía CLI, probe OK); built-in `llama.cpp` de Pi descartado para llama-swap y mlx-serve — usa el router API (`GET /models` con `meta.n_ctx`, `POST /models/load`, `/models/sse`) que ninguno implementa completo, y caería al default de 128000; todos los Servers van como Provider en `models.json`; namespace del comando (`/local-models` sin prefijo; migra a `gentle:` solo como parte de un PR upstream).

## 9. Fases de entrega

- **Spike (2–3 días):** cerrar las preguntas 1–3 de §8; validar que un Provider escrito por el plugin aparece en `/model` y en `/gentle:models`; prototipo del writer con backup y validación de schema.
- **v0.1 — Registrar (R1–R4):** `add`, `list`, `prune`, writer seguro, presets, contexto etiquetado, archivo de estado. Utilizable por el equipo.
- **v0.2 — Validar (R5–R8):** `check` completo con reglas de contexto, claves inválidas, writers ajenos, probe de tool calling, Serving Mode y validación de export.
- **Fuera de este PRD:** widget de estado (R9 original) → documento 02. Failover y VRAM quedan en P2.

## 10. Métricas de éxito

- Tiempo de registro de un Server nuevo: < 2 min, medido con un dev que no conoce Pi.
- 0 ciclos SDD rotos por `contextWindow` declarado mayor al real o por agentes concurrentes peleando un slot de inferencia.
- 0 pérdidas de datos en `~/.pi/agent/models.json`: todo cambio tiene backup y ningún campo existente se sobrescribe.
