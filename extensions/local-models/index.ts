// Shell (D1): the only file in this plugin that touches `ctx`. Wraps the
// pure core modules (detect/presets/context/state/models-writer) and the
// thin ui/* wrappers into `/local-models add` (Phase 7). `registerCommand`'s
// handler stays a thin arg-parse + real-ports wiring; `add()` itself is
// fully unit-testable against fakes (tests/index.add.test.ts) and never
// imports Pi's runtime — only its types, which jiti erases (D1, D8).

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { normalize, probe, type FetchLike } from "./detect.ts";
import { provider, thinking, type ServerKind, type ThinkingFormat } from "./presets.ts";
import { resolve as resolveContext, type ContextPorts, type PropsFields, type VModelsFields } from "./context.ts";
import { commit, type ModelInput, type ProviderInput, type WriteOutcome, type WriterPorts } from "./models-writer.ts";
import {
  load as loadState,
  save as saveState,
  type ContextLabel,
  type ModelLabel,
  type ServerRecord,
  type StatePorts,
} from "./state.ts";
import { selectFromList } from "./ui/select-list.ts";
import { editSetting } from "./ui/settings-list.ts";
import { withLoader } from "./ui/bordered-loader.ts";
import { promptWithPrefill } from "./ui/prompt.ts";
import { notify } from "./ui/notify.ts";
import { modelsJsonPath, realContextPorts, realFetchProps, realFetchVModels, realStatePorts, realWriterPorts, stateJsonPath } from "./ports.ts";

const SERVER_KINDS: ServerKind[] = ["mtplx", "omlx", "mlx-serve", "llama-swap", "generic"];

/** Provider keys that `omlx launch pi` / `mtplx start pi` rewrite wholesale (spec R1, WAYFINDER.md). */
const REWRITTEN_PROVIDER_KEYS: Partial<Record<ServerKind, string>> = {
  omlx: "omlx launch pi",
  mtplx: "mtplx start pi",
};

export interface AddContext {
  hasUI: boolean;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setWorkingMessage(message?: string): void;
    setWorkingVisible(visible: boolean): void;
  };
}

export interface AddPorts {
  fetch: FetchLike;
  /** Real impl re-fetches `{baseUrl}/models` for context.resolve's source (1); see ports.ts. */
  fetchVModels(baseUrl: string): Promise<Record<string, VModelsFields>>;
  /** Real impl fetches `{origin}/props` for context.resolve's source (2); see ports.ts. */
  fetchProps(baseUrl: string): Promise<PropsFields | undefined>;
  contextPorts: ContextPorts;
  writer: { path: string; ports: WriterPorts };
  state: StatePorts;
}

function existingModelIn(raw: string | undefined, providerKey: string, modelId: string): { contextWindow?: number } | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as {
      providers?: Record<string, { models?: Array<{ id: string; contextWindow?: number }> }>;
    };
    return parsed.providers?.[providerKey]?.models?.find((model) => model.id === modelId);
  } catch {
    return undefined;
  }
}

function renderOutcome(outcome: WriteOutcome, writerPath: string): { message: string; type: "info" | "warning" | "error" } {
  switch (outcome.kind) {
    case "written":
      return { message: "written", type: "info" }; // superseded by the success message built by the caller
    case "refused":
      return { message: "Refusing to write models.json: it contains comments. Remove them and retry.", type: "error" };
    case "invalid":
      return {
        message: `models.json write aborted (invalid): ${outcome.errors.join("; ")}. Backups: ${
          outcome.backups.length > 0 ? outcome.backups.join(", ") : "none"
        }.`,
        type: "error",
      };
    case "restored":
      return {
        message: `Write failed (${outcome.error}). Restored backup ${outcome.path}. ${
          outcome.verification.ok ? "Restore verified." : `Restore verification failed: ${outcome.verification.error}`
        }`,
        type: "error",
      };
    case "rolled-back":
      return { message: `Write failed (${outcome.error}). No backup existed; rolled back to no file.`, type: "error" };
    case "restore-failed":
      return {
        message: `Write failed (${outcome.error}), and restoring backup ${outcome.path} also failed (${outcome.reason}). The failed write is left in place at ${writerPath} — inspect manually.`,
        type: "error",
      };
    case "write-failed":
      return {
        message: `Write failed during ${outcome.stage}: ${outcome.error}. File state: ${outcome.fileState}${
          outcome.backup ? ` (backup: ${outcome.backup})` : ""
        }.`,
        type: "error",
      };
  }
}

/**
 * `/local-models add <baseUrl>` (Phase 7, R1/R2/R3/R4). Fully testable
 * against fakes — no Pi runtime import, only `AddContext`/`AddPorts`
 * shapes. See design.md's "Data Flow — one add" for the full walkthrough.
 */
export async function add(input: string, ctx: AddContext, ports: AddPorts): Promise<void> {
  let baseUrl: string;
  try {
    baseUrl = normalize(input);
  } catch (error) {
    // R3-002: normalize() throws on empty/garbage input; translate rather
    // than letting it escape the shell's one entry point for typed URLs.
    notify(ctx.ui, `"${input}" is not a valid Server URL: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }

  const probeResult = await withLoader(ctx.ui, `Probing ${baseUrl}…`, () => probe(ports.fetch, baseUrl));
  if (probeResult.status === "unreachable") {
    notify(ctx.ui, `Could not reach ${baseUrl}: ${probeResult.error}`, "error");
    return;
  }

  const kind = (await selectFromList(ctx.ui, "Server kind", SERVER_KINDS)) as ServerKind | undefined;
  if (kind === undefined) {
    notify(ctx.ui, "Registration cancelled.", "info");
    return;
  }

  // Provider key IS the Server kind (v0.1: one Server per kind) — this is
  // also exactly the key omlx/mtplx's own writers use, so the rewrite
  // warning below is a direct equality check, not a heuristic.
  const providerKey = kind;
  const rewriter = REWRITTEN_PROVIDER_KEYS[kind];
  if (rewriter) {
    notify(ctx.ui, `Provider key "${providerKey}" will be rewritten by ${rewriter} the next time it runs.`, "warning");
  }

  // Best-effort pre-read to decide which models need context resolution
  // (D-005). A failure here is not fatal — `commit()` below re-reads the
  // same path independently and is the source of truth for reporting a
  // genuine read failure as a `write-failed` outcome.
  let existingRaw: string | undefined;
  try {
    existingRaw = await ports.writer.ports.readFile(ports.writer.path);
  } catch {
    existingRaw = undefined;
  }
  const needsContext = probeResult.models.some((modelId) => existingModelIn(existingRaw, providerKey, modelId)?.contextWindow === undefined);

  // R4-005: both cold metadata reads are bounded (see ports.ts's
  // CONTEXT_FETCH_TIMEOUT_MS) and wrapped in the same loader so a slow
  // Server shows working feedback instead of an apparently-frozen prompt.
  const { vModels, props } = needsContext
    ? await withLoader(ctx.ui, `Reading context metadata from ${baseUrl}…`, async () => ({
        vModels: await ports.fetchVModels(baseUrl),
        props: await ports.fetchProps(baseUrl),
      }))
    : { vModels: {} as Record<string, VModelsFields>, props: undefined as PropsFields | undefined };

  const models: ModelInput[] = [];
  const labels: Record<string, ModelLabel> = {};
  const placeholderModels: string[] = [];

  for (const modelId of probeResult.models) {
    const already = existingModelIn(existingRaw, providerKey, modelId);
    let contextWindow: number | undefined;

    if (already?.contextWindow === undefined) {
      const resolution = await resolveContext(modelId, { vModels: vModels[modelId], props }, ports.contextPorts);
      if (resolution.kind === "resolved") {
        contextWindow = resolution.value;
        labels[modelId] = { contextLabel: resolution.label, contextSource: resolution.source };
      } else {
        // D-006/D-007: promptWithPrefill already resolves to `undefined`
        // both on editor cancellation AND when `!ctx.hasUI` (no dialog
        // attempted) — both cases take this SAME placeholder path.
        const answer = await promptWithPrefill(ctx, `contextWindow — ${modelId}`, "32768");
        if (answer !== undefined) {
          const parsed = Number(answer);
          contextWindow = Number.isFinite(parsed) ? parsed : undefined;
          labels[modelId] = { contextLabel: "declarado" as ContextLabel, contextSource: "prompt" };
        } else {
          placeholderModels.push(modelId);
          labels[modelId] = { contextLabel: "placeholder" as ContextLabel, contextSource: "none" };
        }
      }
    }
    // D-005: `already.contextWindow` is defined — never call resolveContext,
    // never write a new label; `labels` simply has no entry for this model,
    // and the merge below preserves whatever label already lived in state.

    const heuristic = thinking(modelId, true);
    let thinkingFormat: ThinkingFormat | undefined = heuristic;
    if (heuristic !== undefined && ctx.hasUI) {
      const edited = await editSetting(ctx.ui, `thinkingFormat — ${modelId}`, heuristic);
      if (edited !== undefined && edited !== "") {
        thinkingFormat = edited as ThinkingFormat;
      }
    }

    models.push({
      id: modelId,
      contextWindow,
      reasoning: heuristic !== undefined ? true : undefined,
      compat: thinkingFormat !== undefined ? { thinkingFormat } : undefined,
    });
  }

  const providerInput: ProviderInput = {
    baseUrl,
    apiKey: "local",
    compat: provider(kind),
    models,
  };
  if (kind === "mtplx") {
    providerInput.headers = { "x-mtplx-client": "pi" };
  }
  if (kind === "omlx") {
    providerInput.authHeader = true;
  }

  const outcome = await withLoader(ctx.ui, `Writing ${ports.writer.path}…`, () =>
    commit(ports.writer.ports, ports.writer.path, providerKey, providerInput),
  );

  if (outcome.kind !== "written") {
    const { message, type } = renderOutcome(outcome, ports.writer.path);
    notify(ctx.ui, message, type);
    return;
  }

  notify(ctx.ui, `Registered "${providerKey}" with ${models.length} model${models.length === 1 ? "" : "s"}.`, "info");
  if (outcome.lint.length > 0) {
    notify(ctx.ui, `models.json lint warnings: ${outcome.lint.join("; ")}`, "warning");
  }
  if (placeholderModels.length > 0) {
    notify(ctx.ui, `contextWindow omitted for: ${placeholderModels.join(", ")} — set it manually before compaction.`, "warning");
  }

  const state = await loadState(ports.state);
  const existingIdx = state.servers.findIndex((server) => server.providerKey === providerKey);
  const servingMode = probeResult.models.length > 1 ? "on-demand" : "single-model";
  const record: ServerRecord = {
    baseUrl,
    kind,
    servingMode,
    providerKey,
    owner: "plugin",
    models: { ...(existingIdx >= 0 ? state.servers[existingIdx].models : {}), ...labels },
  };
  const servers = existingIdx >= 0 ? state.servers.map((server, i) => (i === existingIdx ? record : server)) : [...state.servers, record];
  await saveState(ports.state, { ...state, servers });
}

async function realVerifyWritten(
  ctx: ExtensionCommandContext,
  providerKey: string,
  modelIds: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  await ctx.modelRegistry.refresh({ allowNetwork: false });
  const error = ctx.modelRegistry.getError();
  if (error) {
    return { ok: false, error };
  }
  for (const modelId of modelIds) {
    if (!ctx.modelRegistry.find(providerKey, modelId)) {
      return { ok: false, error: `model "${modelId}" not found in provider "${providerKey}" after refresh` };
    }
  }
  return { ok: true };
}

function buildAddPorts(ctx: ExtensionCommandContext): AddPorts {
  const boundFetch = fetch as unknown as FetchLike;
  const writerPath = modelsJsonPath();
  return {
    fetch: boundFetch,
    fetchVModels: realFetchVModels(boundFetch),
    fetchProps: realFetchProps(boundFetch),
    contextPorts: realContextPorts(),
    writer: {
      path: writerPath,
      ports: realWriterPorts((providerKey, modelIds) => realVerifyWritten(ctx, providerKey, modelIds)),
    },
    state: realStatePorts(stateJsonPath()),
  };
}

export default function localModelsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("local-models", {
    description: "Register, list, and prune local model Servers as Pi Providers.",
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (subcommand === "add") {
        const baseUrlInput = rest.join(" ");
        if (!baseUrlInput) {
          ctx.ui.notify("Usage: /local-models add <baseUrl>", "error");
          return;
        }
        await add(baseUrlInput, ctx, buildAddPorts(ctx));
        return;
      }

      ctx.ui.notify(
        `"${subcommand ?? ""}" is not available yet — only "add" is implemented so far. Usage: /local-models add <baseUrl>`,
        "warning",
      );
    },
  });
}
