// Pure core module — no `ctx`/`ui` import, no Pi runtime dependency (D1, D-003).
// Resolves `contextWindow` from the source priority chain in R4 and returns
// a discriminated result; it never prompts. The ask-at-registration prompt
// (source 4, labeled `declarado`) and the non-interactive `placeholder`
// fallback both live in the shell (Phase 7), which decides what to do with
// an `unresolved` result.

export interface VModelsFields {
  max_model_len?: number;
  context_length?: number;
  meta?: { context_length?: number };
  // Server-declared capabilities (e.g. mlx-serve's /v1/models "capabilities"
  // array including "reasoning"). R4 (contextWindow resolution) never reads
  // this field — it rides along here purely so the shell's R3-015 reasoning
  // confirm flow can tell a Server-verified capability apart from its own
  // family-name heuristic, without a second fetch.
  capabilities?: string[];
}

export interface PropsFields {
  default_generation_settings?: { n_ctx?: number };
  // Server-reported dynamic limits (e.g. mlx-serve's memory.max_safe_context)
  // may ride along on /props, but R4 forbids using them to resolve or alter
  // contextWindow — this type documents the field only so callers can pass
  // the raw /props payload through without stripping it themselves.
  memory?: { max_safe_context?: number };
}

export interface ContextSources {
  vModels?: VModelsFields;
  props?: PropsFields;
}

export interface ContextPorts {
  // Reads llama-swap's config.yaml. The shell owns the actual filesystem
  // read and decides whether it applies (e.g. only for `llama-swap` Servers);
  // this port just returns the raw text, or undefined if there is nothing to
  // read. Parsing the `--ctx-size` value for a given model id stays here,
  // as a pure function.
  readLlamaSwapConfig(): Promise<string | undefined>;
}

export type ContextSource = "v1/models" | "props" | "llama-swap-config";

export type ContextResolution =
  | { kind: "resolved"; value: number; label: "verificado"; source: ContextSource }
  | { kind: "unresolved" };

function fromVModels(fields?: VModelsFields): number | undefined {
  if (!fields) {
    return undefined;
  }
  if (typeof fields.max_model_len === "number") {
    return fields.max_model_len;
  }
  if (typeof fields.context_length === "number") {
    return fields.context_length;
  }
  if (typeof fields.meta?.context_length === "number") {
    return fields.meta.context_length;
  }
  return undefined;
}

function fromProps(fields?: PropsFields): number | undefined {
  const nCtx = fields?.default_generation_settings?.n_ctx;
  return typeof nCtx === "number" ? nCtx : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extracts the `--ctx-size` value for a given model id from a llama-swap
 * `config.yaml`. Finds the model's mapping block under `models:` (matching
 * its key, quoted or not) and reads `--ctx-size` from within that block only
 * — a sibling model's flag never leaks across blocks.
 */
function parseLlamaSwapCtxSize(configText: string, modelId: string): number | undefined {
  const lines = configText.split("\n");
  const keyPattern = new RegExp(`^(\\s*)["']?${escapeRegExp(modelId)}["']?\\s*:\\s*$`);

  let inBlock = false;
  let blockIndent = 0;

  for (const line of lines) {
    if (!inBlock) {
      const match = line.match(keyPattern);
      if (match) {
        inBlock = true;
        blockIndent = match[1].length;
      }
      continue;
    }

    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    const isBlank = line.trim().length === 0;
    if (!isBlank && indent <= blockIndent) {
      break;
    }

    if (line.trim().startsWith("#")) {
      continue;
    }

    const ctxSizeMatch = line.match(/--ctx-size[=\s]+(\d+)/);
    if (ctxSizeMatch) {
      return Number(ctxSizeMatch[1]);
    }
  }

  return undefined;
}

async function fromLlamaSwapConfig(modelId: string, ports: ContextPorts): Promise<number | undefined> {
  const configText = await ports.readLlamaSwapConfig();
  if (!configText) {
    return undefined;
  }
  return parseLlamaSwapCtxSize(configText, modelId);
}

/**
 * Resolves a model's `contextWindow` following R4's source priority chain:
 * (1) /v1/models fields, (2) /props default_generation_settings.n_ctx,
 * (3) llama-swap config.yaml --ctx-size. All three are labeled `verificado`.
 * Returns `{ kind: "unresolved" }` when none resolve — it never prompts;
 * the ask-at-registration fallback (source 4, `declarado`) is the shell's
 * responsibility (Phase 7).
 */
export async function resolve(
  modelId: string,
  sources: ContextSources,
  ports: ContextPorts,
): Promise<ContextResolution> {
  const vModelsValue = fromVModels(sources.vModels);
  if (vModelsValue !== undefined) {
    return { kind: "resolved", value: vModelsValue, label: "verificado", source: "v1/models" };
  }

  const propsValue = fromProps(sources.props);
  if (propsValue !== undefined) {
    return { kind: "resolved", value: propsValue, label: "verificado", source: "props" };
  }

  const llamaSwapValue = await fromLlamaSwapConfig(modelId, ports);
  if (llamaSwapValue !== undefined) {
    return { kind: "resolved", value: llamaSwapValue, label: "verificado", source: "llama-swap-config" };
  }

  return { kind: "unresolved" };
}
