// Shell (D1): the only file in this plugin that touches `ctx`. Wraps the
// pure core modules (detect/presets/context/state/models-writer) and the
// thin ui/* wrappers into `/local-models add` (Phase 7). `registerCommand`'s
// handler stays a thin arg-parse + real-ports wiring; `add()` itself is
// fully unit-testable against fakes (tests/index.add.test.ts) and never
// imports Pi's runtime — only its types, which jiti erases (D1, D8).

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isLocalHost, normalize, probe, probeAll, type FetchLike } from "./detect.ts";
import {
  CONTEXT_WINDOW_PRESETS,
  DIALOG_ID_LIMIT,
  kindFromOwnedBy,
  provider,
  thinking,
  type ServerKind,
  type ThinkingFormat,
} from "./presets.ts";
import { resolve as resolveContext, type ContextPorts, type PropsFields, type VModelsFields } from "./context.ts";
import {
  commit,
  commitPrune,
  listProviders,
  type ModelInput,
  type ProviderInput,
  type PruneRemoval,
  type WriteOutcome,
  type WriterPorts,
} from "./models-writer.ts";
import {
  load as loadState,
  ownerOf,
  save as saveState,
  withLastError,
  type ContextLabel,
  type ModelLabel,
  type Owner,
  type ServerRecord,
  type StatePorts,
} from "./state.ts";
import { selectFromList } from "./ui/select-list.ts";
import { toggleSetting } from "./ui/settings-list.ts";
import { withLoader } from "./ui/bordered-loader.ts";
import { promptWithPrefill } from "./ui/prompt.ts";
import { notify } from "./ui/notify.ts";
import { modelsJsonPath, realContextPorts, realFetchProps, realFetchVModels, realStatePorts, realWriterPorts, stateJsonPath } from "./ports.ts";

const SERVER_KINDS: ServerKind[] = ["mtplx", "omlx", "mlx-serve", "llama-swap", "generic"];

const CUSTOM_CONTEXT_WINDOW_OPTION = "Custom…";

/**
 * Joins `items` for inline display in a dialog title/message, bounded at
 * `DIALOG_ID_LIMIT` entries — beyond that, appends "… and N more" instead of
 * listing every remaining entry (R4-010).
 */
function boundedJoin(items: string[], limit = DIALOG_ID_LIMIT): string {
  if (items.length <= limit) {
    return items.join(", ");
  }
  return `${items.slice(0, limit).join(", ")} … and ${items.length - limit} more`;
}

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
        message: `Write failed (${outcome.error}). ${
          outcome.verification.ok
            ? `Backup restored and verified: ${outcome.path}.`
            : `Restored backup ${outcome.path}, but the restored file failed to load: ${outcome.verification.error}.`
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
    case "write-failed": {
      // R2-006: `stage:"restore"`/`fileState:"unverified-write"` means the
      // restore machinery itself blew up while already trying to recover
      // from a bad write — the file at `writerPath` may hold that bad,
      // unconfirmed write. That is at least as actionable as the
      // `restore-failed` message above: name the file, name the newest
      // backup when one exists, and tell the user to inspect/restore
      // manually rather than trusting the enum alone.
      if (outcome.stage === "restore" && outcome.fileState === "unverified-write") {
        const backupNote = outcome.backup
          ? `The newest backup is at ${outcome.backup} — restore it manually after inspecting ${writerPath}.`
          : `No backup is available — inspect ${writerPath} manually before trusting it.`;
        return {
          message: `Write failed during restore: ${outcome.error}. ${writerPath} may be corrupted or contain an unverified write. ${backupNote}`,
          type: "error",
        };
      }
      return {
        message: `Write failed during ${outcome.stage}: ${outcome.error}. File state: ${outcome.fileState}${
          outcome.backup ? ` (backup: ${outcome.backup})` : ""
        }.`,
        type: "error",
      };
    }
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
  if (probeResult.status !== "reachable") {
    // R1-006/R3-021: "empty" (the Server responded but reports zero models)
    // is still not registerable — there is nothing to add — so it takes the
    // same rejection path as a genuine connection failure, with its own copy.
    const detail = probeResult.status === "empty" ? "reachable but reported zero models" : probeResult.error;
    notify(ctx.ui, `Could not reach ${baseUrl}: ${detail}`, "error");
    return;
  }

  // v0.1.1 hotfix item 3a: preselect the kind the Server itself declared via
  // /v1/models' owned_by — shown first in the picker, still overridable. A
  // cancel aborts exactly as before.
  const detectedKind = kindFromOwnedBy(probeResult.ownedBy);
  const orderedKinds = [detectedKind, ...SERVER_KINDS.filter((k) => k !== detectedKind)];
  const kind = (await selectFromList(ctx.ui, "Server kind", orderedKinds)) as ServerKind | undefined;
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

  // v0.1.1 hotfix item 3b: resolve every model through context.resolve
  // first (D-005 unchanged); collect the ones left `unresolved` for ONE
  // batched prompt below instead of one dialog per model.
  const contextOutcomes = new Map<string, { contextWindow?: number; label?: ModelLabel }>();
  const unresolvedModels: string[] = [];

  for (const modelId of probeResult.models) {
    const already = existingModelIn(existingRaw, providerKey, modelId);
    if (already?.contextWindow !== undefined) {
      // D-005: never call resolveContext, never write a new label — the
      // merge below preserves whatever label already lived in state.
      contextOutcomes.set(modelId, {});
      continue;
    }

    const resolution = await resolveContext(modelId, { vModels: vModels[modelId], props }, ports.contextPorts);
    if (resolution.kind === "resolved") {
      contextOutcomes.set(modelId, {
        contextWindow: resolution.value,
        label: { contextLabel: resolution.label, contextSource: resolution.source },
      });
    } else {
      unresolvedModels.push(modelId);
    }
  }

  const placeholderModels: string[] = [];

  if (unresolvedModels.length > 0 && ctx.hasUI) {
    const title = `Context window for ${unresolvedModels.length} model${unresolvedModels.length === 1 ? "" : "s"} without a source: ${boundedJoin(unresolvedModels)}`;
    const options = [...CONTEXT_WINDOW_PRESETS.map((preset) => preset.label), CUSTOM_CONTEXT_WINDOW_OPTION];
    const choice = await selectFromList(ctx.ui, title, options);

    let appliedValue: number | undefined;
    if (choice === CUSTOM_CONTEXT_WINDOW_OPTION) {
      // D-006/D-007: promptWithPrefill resolves to `undefined` on editor
      // cancellation — same placeholder path as an invalid answer below.
      const answer = await promptWithPrefill(ctx, `contextWindow — ${unresolvedModels.length} model(s)`, "32768");
      // R3-016: validate the answer — empty, non-numeric, NaN, zero, or
      // negative is treated EXACTLY like cancel (never a silent "declarado 0"
      // or "declarado NaN"), plus a notify naming the rejected input.
      const trimmed = answer?.trim();
      const parsed = trimmed ? Number(trimmed) : NaN;
      const isValidPositive = trimmed !== undefined && trimmed !== "" && Number.isFinite(parsed) && parsed > 0;
      if (isValidPositive) {
        appliedValue = parsed;
      } else if (answer !== undefined) {
        notify(
          ctx.ui,
          `contextWindow answer "${answer}" is not a valid positive integer for: ${unresolvedModels.join(", ")} — using placeholder instead.`,
          "warning",
        );
      }
    } else if (choice !== undefined) {
      appliedValue = CONTEXT_WINDOW_PRESETS.find((preset) => preset.label === choice)?.value;
    }
    // `choice === undefined` (cancelled at the select) falls straight
    // through to the placeholder path below, same as an invalid Custom answer.

    for (const modelId of unresolvedModels) {
      if (appliedValue !== undefined) {
        contextOutcomes.set(modelId, {
          contextWindow: appliedValue,
          label: { contextLabel: "declarado" as ContextLabel, contextSource: "prompt" },
        });
      } else {
        placeholderModels.push(modelId);
        contextOutcomes.set(modelId, { label: { contextLabel: "placeholder" as ContextLabel, contextSource: "none" } });
      }
    }
  } else if (unresolvedModels.length > 0) {
    // !ctx.hasUI: no dialog attempted, same omit+placeholder path (D-007).
    for (const modelId of unresolvedModels) {
      placeholderModels.push(modelId);
      contextOutcomes.set(modelId, { label: { contextLabel: "placeholder" as ContextLabel, contextSource: "none" } });
    }
  }

  // v0.1.1 hotfix item 3c: reasoning is still user-confirmed, never
  // heuristic-derived, but confirmed in ONE batch instead of per model.
  // (a) Server-declared capability (e.g. mlx-serve's /v1/models
  //     "capabilities") ⇒ reasoning is verified, not proposed — no confirm.
  // (b) `nothink` (case-insensitive) in the id ⇒ auto-declined, no confirm,
  //     listed in a notice — an explicit non-thinking variant.
  // (c) remaining family-matched models ⇒ ONE confirm covers all of them;
  //     accept sets reasoning + thinkingFormat for every one, decline sets
  //     neither for any of them.
  // (d) no family match ⇒ nothing proposed, as before.
  const declaredReasoningIds = new Set<string>();
  const nothinkModels: string[] = [];
  const familyCandidates: Array<{ id: string; thinkingFormat: ThinkingFormat }> = [];
  const reasoningUnconfirmedModels: string[] = [];

  for (const modelId of probeResult.models) {
    if (vModels[modelId]?.capabilities?.includes("reasoning") === true) {
      declaredReasoningIds.add(modelId);
      continue;
    }
    if (modelId.toLowerCase().includes("nothink")) {
      nothinkModels.push(modelId);
      continue;
    }
    const heuristic = thinking(modelId, true);
    if (heuristic !== undefined) {
      familyCandidates.push({ id: modelId, thinkingFormat: heuristic });
    }
  }

  const acceptedFamilyIds = new Set<string>();
  if (familyCandidates.length > 0) {
    if (ctx.hasUI) {
      const pairs = boundedJoin(familyCandidates.map((c) => `${c.id} → ${c.thinkingFormat}`));
      const accepted = await toggleSetting(
        ctx.ui,
        "Mark reasoning models",
        `Mark ${familyCandidates.length} model${familyCandidates.length === 1 ? "" : "s"} as reasoning models with thinkingFormat per family? ${pairs}`,
      );
      if (accepted) {
        for (const candidate of familyCandidates) {
          acceptedFamilyIds.add(candidate.id);
        }
      }
    } else {
      reasoningUnconfirmedModels.push(...familyCandidates.map((c) => c.id));
    }
  }

  if (nothinkModels.length > 0) {
    notify(ctx.ui, `reasoning auto-declined (id contains "nothink") for: ${nothinkModels.join(", ")}.`, "info");
  }

  const familyFormatById = new Map(familyCandidates.map((c) => [c.id, c.thinkingFormat] as const));
  const models: ModelInput[] = [];
  const labels: Record<string, ModelLabel> = {};

  for (const modelId of probeResult.models) {
    const contextOutcome = contextOutcomes.get(modelId);
    if (contextOutcome?.label !== undefined) {
      labels[modelId] = contextOutcome.label;
    }

    let reasoning: boolean | undefined;
    let thinkingFormat: ThinkingFormat | undefined;
    if (declaredReasoningIds.has(modelId)) {
      reasoning = true;
      thinkingFormat = thinking(modelId, true);
    } else if (acceptedFamilyIds.has(modelId)) {
      reasoning = true;
      thinkingFormat = familyFormatById.get(modelId);
    }

    models.push({
      id: modelId,
      contextWindow: contextOutcome?.contextWindow,
      reasoning,
      compat: thinkingFormat !== undefined ? { thinkingFormat } : undefined,
    });
  }

  if (reasoningUnconfirmedModels.length > 0) {
    notify(
      ctx.ui,
      `reasoning/thinkingFormat not confirmed (non-interactive) for: ${reasoningUnconfirmedModels.join(", ")} — confirm manually if needed.`,
      "warning",
    );
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

  // R4-006: models.json is already the source of truth and was written
  // successfully above — a failure here loses ONLY our own bookkeeping
  // (context labels/ownership), never the registered Provider itself. Guard
  // it explicitly so a rejecting/throwing StatePorts implementation never
  // escapes `add()` unhandled, and report the loss honestly rather than
  // silently pretending it was saved.
  try {
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
  } catch (error) {
    notify(
      ctx.ui,
      `Registered in models.json, but plugin bookkeeping failed (${
        error instanceof Error ? error.message : String(error)
      }): context labels and ownership were not saved. Fix the cause and re-run add.`,
      "warning",
    );
  }
}

export interface ListContext {
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setWorkingMessage(message?: string): void;
    setWorkingVisible(visible: boolean): void;
  };
}

export interface ListPorts {
  fetch: FetchLike;
  writer: { path: string; ports: Pick<WriterPorts, "readFile"> };
  state: StatePorts;
}

interface KnownServer {
  providerKey: string;
  baseUrl: string;
  owner: Owner;
}

/**
 * `/local-models list` (Phase 8, R1, D-004). Known base URLs are the union of
 * models.json Providers and plugin-state Servers, deduped by baseUrl; each
 * is probed with `detect.probeAll` (1s timeout). A Server the plugin already
 * tracks in state gets its `lastError` updated — set on failure, cleared on
 * success — so `prune`/a future Check can read a fresh signal (D-004).
 */
export async function list(ctx: ListContext, ports: ListPorts): Promise<void> {
  const raw = await ports.writer.ports.readFile(ports.writer.path);
  const state = await loadState(ports.state);

  const known = new Map<string, KnownServer>();
  for (const entry of listProviders(raw)) {
    if (entry.baseUrl !== undefined) {
      known.set(entry.baseUrl, { providerKey: entry.providerKey, baseUrl: entry.baseUrl, owner: ownerOf(state, entry.providerKey) });
    }
  }
  for (const server of state.servers) {
    if (!known.has(server.baseUrl)) {
      known.set(server.baseUrl, { providerKey: server.providerKey, baseUrl: server.baseUrl, owner: server.owner });
    }
  }

  const entries = [...known.values()];
  if (entries.length === 0) {
    notify(ctx.ui, "No Servers registered yet. Use /local-models add <baseUrl> to register one.", "info");
    return;
  }

  const probeResults = await withLoader(ctx.ui, `Probing ${entries.length} Server${entries.length === 1 ? "" : "s"}…`, () =>
    probeAll(ports.fetch, entries.map((entry) => entry.baseUrl)),
  );

  let nextState = state;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const probeResult = probeResults[i];
    const hasServerRecord = state.servers.some((server) => server.providerKey === entry.providerKey);

    if (probeResult.status === "unreachable") {
      notify(ctx.ui, `${entry.providerKey} (${entry.owner}) — ${entry.baseUrl} — not detected: ${probeResult.error}`, "warning");
      if (hasServerRecord) {
        nextState = withLastError(nextState, entry.providerKey, probeResult.error);
      }
    } else {
      // R1-006/R3-021: "empty" means the Server RESPONDED (it just reports
      // zero models right now) — that is genuinely "reachable", not
      // "not detected", so it renders in the same informative bucket as a
      // non-empty reachable result and also clears any stale lastError.
      notify(ctx.ui, `${entry.providerKey} (${entry.owner}) — ${entry.baseUrl} — reachable, ${probeResult.models.length} model(s)`, "info");
      if (hasServerRecord) {
        nextState = withLastError(nextState, entry.providerKey, undefined);
      }
    }
  }

  if (nextState !== state) {
    // R4-007: same guard as add()'s R4-006 — the per-provider lines above
    // are already shown and are the actual point of `list`; a
    // rejecting/throwing StatePorts must never escape unhandled and must
    // never silently drop the loss of this run's lastError bookkeeping.
    try {
      await saveState(ports.state, nextState);
    } catch (error) {
      notify(
        ctx.ui,
        `Reachability recorded in memory, but plugin bookkeeping failed (${
          error instanceof Error ? error.message : String(error)
        }): last-error status was not saved.`,
        "warning",
      );
    }
  }
}

export interface PruneContext {
  hasUI: boolean;
  ui: {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setWorkingMessage(message?: string): void;
    setWorkingVisible(visible: boolean): void;
  };
}

export interface PrunePorts {
  fetch: FetchLike;
  writer: { path: string; ports: WriterPorts };
  state: StatePorts;
}

interface PruneCandidate {
  providerKey: string;
  owner: Owner;
  unserved: string[];
}

/**
 * `/local-models prune` (Phase 8, R2, D-004). Scans EVERY local Provider in
 * models.json (loopback/private-host `baseUrl`, per `detect.isLocalHost`) —
 * including ones the plugin never wrote — shows each candidate's ownership,
 * and identifies Unserved Models by comparing a Provider's registered
 * models against a live `probeAll` result. Exactly ONE confirmation covers
 * the whole run; the actual removal goes through `models-writer.commitPrune`
 * (same backup-then-write guarantee as `add`'s `commit()`).
 */
export async function prune(ctx: PruneContext, ports: PrunePorts): Promise<void> {
  const raw = await ports.writer.ports.readFile(ports.writer.path);
  const state = await loadState(ports.state);

  const localProviders = listProviders(raw).filter((entry) => entry.baseUrl !== undefined && isLocalHost(entry.baseUrl));
  if (localProviders.length === 0) {
    notify(ctx.ui, "No local Providers found in models.json.", "info");
    return;
  }

  const probeResults = await withLoader(
    ctx.ui,
    `Checking ${localProviders.length} local Provider${localProviders.length === 1 ? "" : "s"}…`,
    () => probeAll(ports.fetch, localProviders.map((entry) => entry.baseUrl as string)),
  );

  const candidates: PruneCandidate[] = [];
  for (let i = 0; i < localProviders.length; i++) {
    const providerEntry = localProviders[i];
    const probeResult = probeResults[i];

    // R1-006/R3-021: a Server that never RESPONDED has not "reported"
    // anything (glossary: an Unserved Model is one its Server no longer
    // reports). Treating a connection failure/timeout the same as "reports
    // zero models" would offer to prune every model of a Server that is
    // merely down right now — exclude it entirely instead, and say why.
    if (probeResult.status === "unreachable") {
      notify(
        ctx.ui,
        `Could not reach ${providerEntry.baseUrl} (${probeResult.error}) — skipped, nothing will be pruned for ${providerEntry.providerKey}.`,
        "warning",
      );
      continue;
    }

    const liveModelIds = new Set(probeResult.models);
    const unserved = providerEntry.models.map((model) => model.id).filter((id) => !liveModelIds.has(id));
    if (unserved.length > 0) {
      candidates.push({ providerKey: providerEntry.providerKey, owner: ownerOf(state, providerEntry.providerKey), unserved });
    }
  }

  if (candidates.length === 0) {
    notify(ctx.ui, "No Unserved Models found to prune.", "info");
    return;
  }

  const summary = candidates.map((c) => `${c.providerKey} (${c.owner}): ${c.unserved.join(", ")}`).join("\n");

  if (!ctx.hasUI) {
    notify(ctx.ui, `Found Unserved Models but cannot confirm non-interactively — re-run interactively to prune:\n${summary}`, "warning");
    return;
  }

  const confirmed = await ctx.ui.confirm("Prune Unserved Models", `Remove the following Unserved Models?\n${summary}`);
  if (!confirmed) {
    notify(ctx.ui, "Prune cancelled.", "info");
    return;
  }

  const removals: PruneRemoval[] = candidates.map((c) => ({ providerKey: c.providerKey, modelIds: c.unserved }));
  const outcome = await withLoader(ctx.ui, `Writing ${ports.writer.path}…`, () => commitPrune(ports.writer.ports, ports.writer.path, removals));

  if (outcome.kind !== "written") {
    const { message, type } = renderOutcome(outcome, ports.writer.path);
    notify(ctx.ui, message, type);
    return;
  }

  const prunedCount = removals.reduce((total, r) => total + r.modelIds.length, 0);
  notify(ctx.ui, `Pruned ${prunedCount} Unserved Model${prunedCount === 1 ? "" : "s"} from ${removals.length} Provider${removals.length === 1 ? "" : "s"}.`, "info");
  if (outcome.lint.length > 0) {
    notify(ctx.ui, `models.json lint warnings: ${outcome.lint.join("; ")}`, "warning");
  }
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

function buildCommandPorts(ctx: ExtensionCommandContext): AddPorts {
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
        await add(baseUrlInput, ctx, buildCommandPorts(ctx));
        return;
      }

      if (subcommand === "list") {
        await list(ctx, buildCommandPorts(ctx));
        return;
      }

      if (subcommand === "prune") {
        await prune(ctx, buildCommandPorts(ctx));
        return;
      }

      ctx.ui.notify(
        `"${subcommand ?? ""}" is not available — usage: /local-models add <baseUrl> | list | prune`,
        "warning",
      );
    },
  });
}
