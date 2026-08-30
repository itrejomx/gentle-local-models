// Pure core module — no `ctx` import, no Pi runtime dependency (D1).
// Writes ~/.pi/agent/models.json safely (R2, D-001): fill-never-overwrite
// merge, a comment guard, pre-write validation against a mirrored TypeBox
// schema, compat-key lint, rotating backups, and a read-back-verified write
// with automatic restore. All I/O is injected via `WriterPorts` (D3) so this
// module is fully unit-testable without touching the real filesystem.
//
// The mirrored schema (D2) covers ONLY the fields this plugin itself writes
// — `baseUrl`/`apiKey`/`compat` at the Provider level, `id`/`name`/
// `contextWindow`/`maxTokens`/`reasoning`/`input`/`compat` at the Model level
// — and stays exactly as permissive as Pi's own schema (no
// `additionalProperties: false`), confirmed against Pi's real
// `core/model-config.js` ProviderConfigSchema/ModelDefinitionSchema (`models`
// is an array of `{ id, ... }`, not a Record). Every other field a
// hand-curated Provider carries (cost, headers, thinkingLevelMap, ...) rides
// through the merge untouched because the merge operates on the raw parsed
// JSON and only ever reads/writes the fields it knows about.

import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { CompatBlock, ThinkingFormat } from "./presets.ts";

type Json = Record<string, unknown>;

// Conservative default applied only when filling a Model's missing
// `maxTokens` (R2's one explicitly-specified "conservative default" case).
// Other missing fields (contextWindow, reasoning, input, compat) are left
// absent rather than guessed — contextWindow resolution belongs to R4's
// context.ts + the shell's interactive prompt, not to this writer.
const DEFAULT_MAX_TOKENS = 4096;

const KNOWN_PROVIDER_COMPAT_KEYS = new Set<string>([
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "maxTokensField",
]);
const KNOWN_MODEL_COMPAT_KEYS = new Set<string>(["thinkingFormat"]);

export interface ModelInput {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  compat?: { thinkingFormat?: ThinkingFormat };
}

export interface ProviderInput {
  baseUrl?: string;
  apiKey?: string;
  compat?: CompatBlock;
  models: ModelInput[];
}

export interface WriterPorts {
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, contents: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listBackups(path: string): Promise<string[]>;
  now(): number;
  verifyWritten(providerKey: string, modelIds: string[]): Promise<{ ok: true } | { ok: false; error: string }>;
}

export type WriteOutcome =
  | { kind: "written"; backup?: string; lint: string[] }
  | { kind: "refused"; reason: "comments" }
  | { kind: "invalid"; errors: string[] }
  | { kind: "restored"; backup: string; error: string };

function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...(value as Json) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

/**
 * Detects comments (`//` or `/* *\/`) anywhere outside JSON string literals.
 * Pi's own reader tolerates comments (`stripJsonComments`), so a hand-edited
 * models.json can legitimately contain them; a naive JSON.parse/stringify
 * round-trip would silently delete them. This scans char-by-char, tracking
 * whether we are inside a string, so `"http://localhost"` never false-alarms.
 */
export function hasComments(raw: string): boolean {
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "/" && (raw[i + 1] === "/" || raw[i + 1] === "*")) {
      return true;
    }
  }

  return false;
}

function fillModel(existing: Json, input: ModelInput): void {
  if (existing.name === undefined) {
    existing.name = input.name ?? input.id;
  }
  if (existing.contextWindow === undefined && input.contextWindow !== undefined) {
    existing.contextWindow = input.contextWindow;
  }
  if (existing.maxTokens === undefined) {
    existing.maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  }
  if (existing.reasoning === undefined && input.reasoning !== undefined) {
    existing.reasoning = input.reasoning;
  }
  if (existing.input === undefined && input.input !== undefined) {
    existing.input = input.input;
  }
  if (existing.compat === undefined && input.compat !== undefined) {
    existing.compat = input.compat;
  }
}

function createModel(input: ModelInput): Json {
  const created: Json = { id: input.id, name: input.name ?? input.id };
  if (input.contextWindow !== undefined) {
    created.contextWindow = input.contextWindow;
  }
  created.maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (input.reasoning !== undefined) {
    created.reasoning = input.reasoning;
  }
  if (input.input !== undefined) {
    created.input = input.input;
  }
  if (input.compat !== undefined) {
    created.compat = input.compat;
  }
  return created;
}

/**
 * Fill-never-overwrite merge (R2): existing Provider/Model fields are never
 * replaced, only missing ones are filled; new Models are added with
 * `name = id`; Models no longer in `input.models` (Unserved Models) are left
 * in place, never removed. Operates on the raw parsed JSON so any field this
 * module doesn't know about (on Providers or Models it didn't create) is
 * preserved untouched. Never mutates `existingRaw`.
 */
export function mergeProvider(existingRaw: unknown, providerKey: string, input: ProviderInput): Json {
  const file = asObject(existingRaw);
  const providers = asObject(file.providers);
  const provider = asObject(providers[providerKey]);

  if (provider.baseUrl === undefined && input.baseUrl !== undefined) {
    provider.baseUrl = input.baseUrl;
  }
  if (provider.apiKey === undefined && input.apiKey !== undefined) {
    provider.apiKey = input.apiKey;
  }
  if (provider.compat === undefined && input.compat !== undefined) {
    provider.compat = input.compat;
  }

  const models = asArray(provider.models).map((m) => asObject(m));
  const byId = new Map(models.map((m) => [m.id as string, m]));

  for (const modelInput of input.models) {
    const existing = byId.get(modelInput.id);
    if (existing) {
      fillModel(existing, modelInput);
    } else {
      const created = createModel(modelInput);
      byId.set(modelInput.id, created);
      models.push(created);
    }
  }

  provider.models = models;
  providers[providerKey] = provider;
  file.providers = providers;
  return file;
}

const ModelCompatSchema = Type.Object({
  // Permissive on purpose (D2): Pi's real thinkingFormat is an 11-value
  // literal union, but this mirror only needs to structurally validate the
  // one field this plugin writes at the Model level, without rejecting a
  // pre-existing file that legitimately uses a value outside our own
  // heuristic's 3-value output range.
  thinkingFormat: Type.Optional(Type.String()),
});

const ProviderCompatSchema = Type.Object({
  supportsDeveloperRole: Type.Optional(Type.Boolean()),
  supportsReasoningEffort: Type.Optional(Type.Boolean()),
  maxTokensField: Type.Optional(Type.String()),
});

const ModelEntrySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String({ minLength: 1 })),
  contextWindow: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
  compat: Type.Optional(ModelCompatSchema),
});

const ProviderSchema = Type.Object({
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  apiKey: Type.Optional(Type.String({ minLength: 1 })),
  compat: Type.Optional(ProviderCompatSchema),
  models: Type.Optional(Type.Array(ModelEntrySchema)),
});

const ModelsFileSchema = Type.Object({
  providers: Type.Record(Type.String(), ProviderSchema),
});

const validator = Compile(ModelsFileSchema);

/** Pre-write validation (R2) against the mirrored schema. File-shape only — see module header for scope. */
export function validate(file: unknown): { ok: true } | { ok: false; errors: string[] } {
  if (validator.Check(file)) {
    return { ok: true };
  }
  const errors = [...validator.Errors(file)].map((error) => `${error.instancePath || "root"}: ${error.message}`);
  return { ok: false, errors };
}

function warnUnknownKeys(compatRaw: unknown, known: Set<string>, label: string, warnings: string[]): void {
  if (compatRaw === undefined) {
    return;
  }
  const compat = asObject(compatRaw);
  for (const key of Object.keys(compat)) {
    if (!known.has(key)) {
      warnings.push(`Unknown compat key "${key}" on ${label}`);
    }
  }
}

/** Lints `compat` keys against the known list (R2). Never blocks the write — warnings only. */
export function lint(fileRaw: unknown): string[] {
  const file = asObject(fileRaw);
  const providers = asObject(file.providers);
  const warnings: string[] = [];

  for (const [providerKey, providerRaw] of Object.entries(providers)) {
    const provider = asObject(providerRaw);
    warnUnknownKeys(provider.compat, KNOWN_PROVIDER_COMPAT_KEYS, `Provider "${providerKey}"`, warnings);

    for (const modelRaw of asArray(provider.models)) {
      const model = asObject(modelRaw);
      warnUnknownKeys(model.compat, KNOWN_MODEL_COMPAT_KEYS, `Model "${model.id}" (${providerKey})`, warnings);
    }
  }

  return warnings;
}

function backupEpoch(backupPath: string): number {
  const match = backupPath.match(/\.(\d+)\.bak$/);
  return match ? Number(match[1]) : 0;
}

/**
 * Writes a new `{path}.{epoch}.bak` backup of `contents`, then prunes the
 * oldest backups beyond `cap` (default 10, per R2's rotation requirement).
 * Returns the newly created backup's path.
 */
export async function rotateBackups(
  ports: WriterPorts,
  path: string,
  contents: string,
  cap = 10,
): Promise<string> {
  const backupPath = `${path}.${ports.now()}.bak`;
  await ports.writeFile(backupPath, contents);

  const backups = await ports.listBackups(path);
  const sorted = [...backups].sort((a, b) => backupEpoch(a) - backupEpoch(b));
  const overflow = sorted.length - cap;
  for (let i = 0; i < overflow; i++) {
    await ports.deleteFile(sorted[i]);
  }

  return backupPath;
}

async function restoreNewestBackup(ports: WriterPorts, path: string): Promise<string | undefined> {
  const backups = await ports.listBackups(path);
  const newest = [...backups].sort((a, b) => backupEpoch(b) - backupEpoch(a))[0];
  if (newest === undefined) {
    // No prior state to restore to (first-ever write): roll back to
    // "file does not exist" rather than leaving a bad write in place (D6).
    await ports.deleteFile(path);
    return undefined;
  }
  const contents = await ports.readFile(newest);
  if (contents !== undefined) {
    await ports.writeFile(path, contents);
  }
  return newest;
}

/**
 * Full write orchestration (D-001/D3/D6): read → comment guard → merge
 * (fill-never-overwrite) → mirror validate → backup rotate → write →
 * verifyWritten → restore newest backup on failure. Every abort names the
 * file state it left behind; no thrown exception can leave models.json
 * half-written.
 */
export async function commit(
  ports: WriterPorts,
  path: string,
  providerKey: string,
  input: ProviderInput,
): Promise<WriteOutcome> {
  const raw = await ports.readFile(path);

  if (raw !== undefined && hasComments(raw)) {
    return { kind: "refused", reason: "comments" };
  }

  let existing: unknown = {};
  if (raw !== undefined) {
    try {
      existing = JSON.parse(raw);
    } catch (error) {
      return {
        kind: "invalid",
        errors: [`existing models.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }

  const merged = mergeProvider(existing, providerKey, input);

  const validation = validate(merged);
  if (!validation.ok) {
    return { kind: "invalid", errors: validation.errors };
  }

  const lintWarnings = lint(merged);

  let backupPath: string | undefined;
  if (raw !== undefined) {
    backupPath = await rotateBackups(ports, path, raw);
  }

  await ports.writeFile(path, JSON.stringify(merged, null, 2));

  const modelIds = input.models.map((m) => m.id);
  const verification = await ports.verifyWritten(providerKey, modelIds);

  if (!verification.ok) {
    const restoredFrom = await restoreNewestBackup(ports, path);
    return { kind: "restored", backup: restoredFrom ?? "", error: verification.error };
  }

  return { kind: "written", backup: backupPath, lint: lintWarnings };
}
