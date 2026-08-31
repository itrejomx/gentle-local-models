// Pure core module — no `ctx` import, no Pi runtime dependency (D1).
// Persists known Servers, per-Provider ownership, and per-(provider,model)
// context labels to ~/.pi/agent/gentle-local-models.json (D-002). The shell
// (Phase 7/8) owns the actual path and binds it into `StatePorts`; this
// module never sees a filesystem path, so tests never touch the real home
// dir.

import type { ServerKind } from "./presets.ts";

export type ContextLabel = "verificado" | "declarado" | "placeholder";
export type Owner = "plugin" | "external" | "unknown";
export type ServingMode = "single-model" | "on-demand";

export interface ModelLabel {
  contextLabel: ContextLabel;
  contextSource: string;
}

export interface ServerRecord {
  baseUrl: string;
  kind: ServerKind;
  servingMode: ServingMode;
  providerKey: string;
  owner: Owner;
  lastError?: string;
  models: Record<string, ModelLabel>;
}

export interface PluginState {
  version: 1;
  piVersion: string;
  servers: ServerRecord[];
}

export interface StatePorts {
  readState(): Promise<string | undefined>;
  writeState(contents: string): Promise<void>;
}

function freshState(): PluginState {
  return { version: 1, piVersion: "", servers: [] };
}

function isValid(value: unknown): value is PluginState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && Array.isArray(candidate.servers);
}

/**
 * Loads PluginState via the injected fs port. Never throws: a missing file,
 * invalid JSON, or a structurally invalid payload all recover to a fresh
 * empty state in memory — the on-disk file (if any) is left untouched,
 * since `load()` never writes.
 */
export async function load(ports: StatePorts): Promise<PluginState> {
  const raw = await ports.readState();
  if (raw === undefined) {
    return freshState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return freshState();
  }

  return isValid(parsed) ? parsed : freshState();
}

export async function save(ports: StatePorts, state: PluginState): Promise<void> {
  await ports.writeState(JSON.stringify(state, null, 2));
}

/** Looks up a Provider's ownership; unrecorded Provider keys default to "unknown" (D-004). */
export function ownerOf(state: PluginState, providerKey: string): Owner {
  return state.servers.find((server) => server.providerKey === providerKey)?.owner ?? "unknown";
}

/** Looks up a (Provider, model) pair's context label, or undefined if not recorded. */
export function labelOf(state: PluginState, providerKey: string, modelId: string): ModelLabel | undefined {
  const server = state.servers.find((s) => s.providerKey === providerKey);
  return server?.models?.[modelId];
}

/** Returns a new PluginState with the given (Provider, model) pair's label set. Does not mutate `state`. */
export function withLabel(
  state: PluginState,
  providerKey: string,
  modelId: string,
  label: ModelLabel,
): PluginState {
  return {
    ...state,
    servers: state.servers.map((server) =>
      server.providerKey === providerKey
        ? { ...server, models: { ...server.models, [modelId]: label } }
        : server,
    ),
  };
}

/** Returns a new PluginState with the given Provider's lastError set (or cleared via undefined). Does not mutate `state`. */
export function withLastError(
  state: PluginState,
  providerKey: string,
  lastError: string | undefined,
): PluginState {
  return {
    ...state,
    servers: state.servers.map((server) =>
      server.providerKey === providerKey ? { ...server, lastError } : server,
    ),
  };
}
