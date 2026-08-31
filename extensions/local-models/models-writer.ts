// Pure core module — no `ctx` import, no Pi runtime dependency (D1).
// Writes ~/.pi/agent/models.json safely (R2, D-001): fill-never-overwrite
// merge, a comment guard, pre-write validation against a mirrored TypeBox
// schema, compat-key lint, rotating backups, and a read-back-verified write
// with automatic restore. All I/O is injected via `WriterPorts` (D3) so this
// module is fully unit-testable without touching the real filesystem.
//
// Every stage that calls a `WriterPorts` method (read, rotateBackups, the
// main write, verifyWritten, restore) is wrapped so a rejecting/throwing
// port can never escape `commit()` (C) — it always resolves to a
// `WriteOutcome` value instead, naming the stage and the file state left
// behind. `WriteOutcome`'s restore-related variants (`restored`,
// `rolled-back`, `restore-failed`) report what actually happened rather than
// a single ambiguous `restored` kind (B+F); a successful restore is
// re-verified via a second `verifyWritten` call (D3) before being reported.
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
  // Per-kind extras the Phase 7 shell composes alongside `compat` (never
  // returned by presets.provider() itself — see presets.ts's Phase 2 scope
  // decision): mtplx's `x-mtplx-client` header, omlx's `authHeader` flag.
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: ModelInput[];
}

export interface WriterPorts {
  readFile(path: string): Promise<string | undefined>;
  /**
   * Writes `contents` to `path`. Implementations MUST be atomic — write to a
   * temporary file in the same directory, then rename it into place (a
   * same-filesystem rename is atomic on POSIX). This guarantees there is
   * never a window where a reader can observe `path` holding partial
   * content, and that a process crash mid-write leaves any pre-existing
   * file at `path` untouched (D4). See `tests/models-writer.integration.test.ts`'s
   * `realFsPorts` for the reference implementation Phase 7's real shell port
   * must copy.
   */
  writeFile(path: string, contents: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listBackups(path: string): Promise<string[]>;
  now(): number;
  /**
   * Confirms a write landed, via Pi's own model-registry read-back. Two call
   * conventions (v0.1.1 hotfix item 2 documents both explicitly):
   * - `verifyWritten(providerKey, modelIds)` — a SPECIFIC-model check: refresh,
   *   then confirm every one of `modelIds` is now found under `providerKey`.
   *   Used only right after a MERGE write, where those models are expected to
   *   exist in the result (`commit()`'s primary post-write verify).
   * - `verifyWritten("", [])` — a GENERIC "did the file load cleanly" check:
   *   refresh and report only whether the refresh itself errored, with no
   *   per-model lookup. Used for `commitPrune`'s post-write verify (models
   *   were just REMOVED, so checking for their presence would prove nothing)
   *   AND for the post-RESTORE re-verify after any recovery (the models from
   *   the failed write were rolled back and can never be found — checking for
   *   them there would always report a false failure, never proof the
   *   restored file is good).
   */
  verifyWritten(providerKey: string, modelIds: string[]): Promise<{ ok: true } | { ok: false; error: string }>;
}

export type WriteOutcome =
  | { kind: "written"; backup?: string; lint: string[] }
  | { kind: "refused"; reason: "comments" }
  // File untouched. `backups` (D4c) lists whatever backups are available for
  // this path so the shell can offer manual recovery when the EXISTING file
  // turns out to be corrupted (invalid JSON or schema-invalid).
  | { kind: "invalid"; errors: string[]; backups: string[] }
  // A prior backup existed and was restored. `verification` is the result of
  // re-running `verifyWritten` against the restored content (D3: restore →
  // refresh again → report) — restoring is not itself proof the restored
  // state is good, so that second check rides along honestly.
  | {
      kind: "restored";
      path: string;
      error: string;
      verification: { ok: true } | { ok: false; error: string };
    }
  // No backup existed (first-ever write): rolled back to "file does not
  // exist" rather than leaving the failed write in place. Distinct from
  // `restored` — nothing was restored — so callers never have to guess what
  // an empty `backup: ""` sentinel meant.
  | { kind: "rolled-back"; error: string }
  // A backup existed but restoring from it failed (the backup itself is
  // unreadable, or writing it back failed). The failed write is left in
  // `path` untouched — reported honestly rather than silently discarded.
  | { kind: "restore-failed"; path: string; reason: string; error: string }
  // An injected WriterPorts call itself rejected/threw in a stage that isn't
  // already covered by a richer outcome above (C): reading the existing
  // file, rotating backups, or — as a last resort — the restore machinery
  // itself blowing up while already trying to recover from a bad write. No
  // exception ever escapes `commit()`; `fileState` names what the caller can
  // assume about `path`.
  | {
      kind: "write-failed";
      stage: "read" | "rotate-backups" | "restore";
      error: string;
      fileState: "untouched" | "unverified-write";
      backup?: string;
    };

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

  // v0.1.1 hotfix item 1, extended by the PR11 rider batch: Pi's provider
  // composer requires `api` at the Provider or Model level to resolve
  // requests (live E2E: "no \"api\" specified"). Fill it whenever the
  // Provider-level `api` is absent — NEW or EXISTING alike — never only when
  // the models each already declare their own `api` (fill-never-overwrite's
  // own contract only cares whether the field is absent, not whether some
  // other field would have made it unnecessary). An EXISTING Provider that
  // already carries `api` (any value) is left byte-for-byte untouched, per
  // fill-never-overwrite (R2).
  //
  // Rationale for filling an EXISTING api-less Provider too: a pre-v0.1.1
  // write (or a hand-curated Provider that happens to omit `api`) leaves
  // Pi's registry reporting a composition error on every load, so every
  // subsequent plugin write against that same Provider key would end in a
  // confusing restore (verifyWritten fails because the whole registry never
  // composed). Filling the missing field is exactly this merge's own "fill"
  // case (R2) and self-heals that Provider the next time it is written.
  if (provider.api === undefined) {
    provider.api = "openai-completions";
  }

  if (provider.baseUrl === undefined && input.baseUrl !== undefined) {
    provider.baseUrl = input.baseUrl;
  }
  if (provider.apiKey === undefined && input.apiKey !== undefined) {
    provider.apiKey = input.apiKey;
  }
  if (provider.compat === undefined && input.compat !== undefined) {
    provider.compat = input.compat;
  }
  if (provider.headers === undefined && input.headers !== undefined) {
    provider.headers = input.headers;
  }
  if (provider.authHeader === undefined && input.authHeader !== undefined) {
    provider.authHeader = input.authHeader;
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

/**
 * Removes exactly the given model ids from one Provider's `models` array —
 * `mergeProvider`'s inverse for explicit prune (R2): REMOVES only the
 * confirmed Unserved Models, never touches any other model or any
 * Provider-level field. Operates on the raw parsed JSON, like
 * `mergeProvider`. Never mutates `existingRaw`.
 */
export function removeModels(existingRaw: unknown, providerKey: string, modelIds: string[]): Json {
  const file = asObject(existingRaw);
  const providers = asObject(file.providers);
  const provider = asObject(providers[providerKey]);
  const toRemove = new Set(modelIds);

  provider.models = asArray(provider.models)
    .map((m) => asObject(m))
    .filter((m) => !toRemove.has(m.id as string));
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
  // v0.1.1 hotfix item 1: Pi's provider composer accepts `api` at either the
  // Provider or the Model level; declared here for mirror accuracy even
  // though the permissive schema already tolerated it unlisted.
  api: Type.Optional(Type.String({ minLength: 1 })),
});

const ProviderSchema = Type.Object({
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  apiKey: Type.Optional(Type.String({ minLength: 1 })),
  compat: Type.Optional(ProviderCompatSchema),
  // Phase 7 per-kind extras (mtplx headers, omlx authHeader) — declared here
  // for mirror accuracy even though the permissive schema (no
  // additionalProperties: false) already tolerated them unlisted.
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  authHeader: Type.Optional(Type.Boolean()),
  // v0.1.1 hotfix item 1: required by Pi's provider composer (see ModelEntrySchema.api above).
  api: Type.Optional(Type.String({ minLength: 1 })),
  models: Type.Optional(Type.Array(ModelEntrySchema)),
});

const ModelsFileSchema = Type.Object({
  providers: Type.Record(Type.String(), ProviderSchema),
});

const validator = Compile(ModelsFileSchema);

export interface ProviderEntry {
  providerKey: string;
  baseUrl?: string;
  models: Array<{ id: string }>;
}

/**
 * Read-only Provider enumeration for `list`/`prune` (Phase 8) — the single
 * place that parses `models.json` for reading, so neither shell command
 * hand-rolls its own JSON.parse. Degrades to an empty list on a missing
 * file, invalid JSON, or a comment-containing file, mirroring `state.ts`'s
 * `load()` no-throw convention: reading for DISPLAY never fails loudly, only
 * `commit()`'s WRITE path enforces the comment guard.
 */
export function listProviders(raw: string | undefined): ProviderEntry[] {
  if (raw === undefined || hasComments(raw)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const providers = asObject(asObject(parsed).providers);
  return Object.entries(providers).map(([providerKey, providerRaw]) => {
    const provider = asObject(providerRaw);
    const models = asArray(provider.models)
      .map((m) => asObject(m))
      .filter((m): m is Json & { id: string } => typeof m.id === "string")
      .map((m) => ({ id: m.id }));
    return {
      providerKey,
      baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
      models,
    };
  });
}

/**
 * Pre-write validation (R2) against the mirrored schema. File-shape only —
 * see module header for scope.
 *
 * `strictProviderKeys` (v0.1.1 hotfix item 1, extended by the PR11 rider
 * batch) adds one extra, targeted check on top of the permissive structural
 * mirror: for each listed Provider key — the one THIS write is committing,
 * new or existing — every one of its models must resolve an `api`
 * (Provider-level `api`, or that specific model's own `api`). This is
 * exactly Pi's real provider-composer requirement (`api` at the Provider
 * level OR on every model, `core/provider-composer.js:48-52`), applied on
 * every commit rather than only for brand-new Providers, since
 * `mergeProvider`'s own fill (above) already guarantees this for any
 * Provider it can reach — this check is a targeted backstop, not a
 * behavior-changing gate, for whichever Provider key this write touches. A
 * Provider NOT listed here (untouched by this write) is never held to this
 * check, even if it lacks `api` entirely — the mirror stays exactly as
 * permissive as before for everyone else.
 */
export function validate(
  file: unknown,
  strictProviderKeys: string[] = [],
): { ok: true } | { ok: false; errors: string[] } {
  if (!validator.Check(file)) {
    const errors = [...validator.Errors(file)].map((error) => `${error.instancePath || "root"}: ${error.message}`);
    return { ok: false, errors };
  }

  const providers = asObject(asObject(file).providers);
  const errors: string[] = [];
  for (const providerKey of strictProviderKeys) {
    const provider = asObject(providers[providerKey]);
    const providerHasApi = typeof provider.api === "string" && provider.api.length > 0;
    const models = asArray(provider.models).map((m) => asObject(m));
    for (const model of models) {
      const modelHasApi = typeof model.api === "string" && model.api.length > 0;
      if (!providerHasApi && !modelHasApi) {
        errors.push(
          `Provider "${providerKey}", model "${model.id}": missing "api" (required by Pi's provider composer) at the Provider or Model level`,
        );
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parses a `{path}.{epoch}[-{suffix}].bak` name into a comparable key. The
 * `-{suffix}` form (collision guard, A) only ever appears when a `-0`-free
 * `{epoch}.bak` already existed, so a suffixed backup is always NEWER than
 * its unsuffixed sibling at the same epoch.
 */
function backupKey(backupPath: string): { epoch: number; suffix: number } {
  const match = backupPath.match(/\.(\d+)(?:-(\d+))?\.bak$/);
  if (!match) {
    return { epoch: 0, suffix: 0 };
  }
  return { epoch: Number(match[1]), suffix: match[2] !== undefined ? Number(match[2]) : 0 };
}

function compareBackupsAscending(a: string, b: string): number {
  const ka = backupKey(a);
  const kb = backupKey(b);
  return ka.epoch - kb.epoch || ka.suffix - kb.suffix;
}

/**
 * Writes a new `{path}.{epoch}.bak` backup of `contents`, then prunes the
 * oldest backups beyond `cap` (default 10, per R2's rotation requirement).
 * Returns the newly created backup's path.
 *
 * Collision guard (A): if `{epoch}.bak` already exists — two commits landing
 * in the same clock tick, plausible with a low-resolution `now()` or two
 * rapid `add`s — the path is suffixed `-1`, `-2`, ... until free, so neither
 * commit's pre-image is silently clobbered.
 */
export async function rotateBackups(
  ports: WriterPorts,
  path: string,
  contents: string,
  cap = 10,
): Promise<string> {
  const epoch = ports.now();
  let backupPath = `${path}.${epoch}.bak`;
  let suffix = 0;
  while ((await ports.readFile(backupPath)) !== undefined) {
    suffix++;
    backupPath = `${path}.${epoch}-${suffix}.bak`;
  }
  await ports.writeFile(backupPath, contents);

  const backups = await ports.listBackups(path);
  const sorted = [...backups].sort(compareBackupsAscending);
  const overflow = sorted.length - cap;
  for (let i = 0; i < overflow; i++) {
    await ports.deleteFile(sorted[i]);
  }

  return backupPath;
}

/** What actually happened when `commit()` tried to recover from a bad write. */
type RestoreResult =
  | { status: "restored"; path: string }
  | { status: "rolled-back-no-backup" }
  | { status: "restore-failed"; path: string; reason: string };

async function restoreNewestBackup(ports: WriterPorts, path: string): Promise<RestoreResult> {
  const backups = await ports.listBackups(path);
  const newest = [...backups].sort((a, b) => compareBackupsAscending(b, a))[0];
  if (newest === undefined) {
    // No prior state to restore to (first-ever write): roll back to
    // "file does not exist" rather than leaving a bad write in place (D6).
    await ports.deleteFile(path);
    return { status: "rolled-back-no-backup" };
  }

  const contents = await ports.readFile(newest);
  if (contents === undefined) {
    // The newest backup is itself unreadable (corrupted/missing on disk).
    // Do NOT touch `path` — it still holds the failed write, and reporting
    // that honestly beats silently discarding it (B+F).
    return { status: "restore-failed", path: newest, reason: "backup file is unreadable" };
  }

  try {
    await ports.writeFile(path, contents);
  } catch (error) {
    return { status: "restore-failed", path: newest, reason: `restore write failed: ${errorMessage(error)}` };
  }

  return { status: "restored", path: newest };
}

async function listBackupsSafely(ports: WriterPorts, path: string): Promise<string[]> {
  try {
    return await ports.listBackups(path);
  } catch {
    // Best-effort recovery hint (D4c) — an inability to list backups must
    // not turn an already-computed `invalid` outcome into a throw.
    return [];
  }
}

/**
 * Full write orchestration (D-001/D3/D6): read → comment guard → merge
 * (fill-never-overwrite) → mirror validate → backup rotate → write →
 * verifyWritten → restore newest backup on failure. Every abort names the
 * file state it left behind. Every port-calling stage (read, rotateBackups,
 * the main write, verifyWritten, restore) is wrapped (C): no exception from
 * an injected `WriterPorts` can escape `commit()` — every rejection resolves
 * to a `WriteOutcome` value instead. See `commitPrune` below for the same
 * guarded orchestration applied to model removal instead of merge.
 */
export async function commit(
  ports: WriterPorts,
  path: string,
  providerKey: string,
  input: ProviderInput,
): Promise<WriteOutcome> {
  let raw: string | undefined;
  try {
    raw = await ports.readFile(path);
  } catch (error) {
    return { kind: "write-failed", stage: "read", error: errorMessage(error), fileState: "untouched" };
  }

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
        errors: [`existing models.json is not valid JSON: ${errorMessage(error)}`],
        // Recovery hint (D4c): a corrupted EXISTING file is exactly the case
        // where the shell should be able to offer "restore from a backup".
        backups: await listBackupsSafely(ports, path),
      };
    }
  }

  const merged = mergeProvider(existing, providerKey, input);

  // PR11 rider batch item 1: the strict api requirement is checked for the
  // target `providerKey` on every commit — new or existing — not only when
  // this write is creating it brand new. See validate()'s JSDoc.
  const validation = validate(merged, [providerKey]);
  if (!validation.ok) {
    return { kind: "invalid", errors: validation.errors, backups: await listBackupsSafely(ports, path) };
  }

  const lintWarnings = lint(merged);

  let backupPath: string | undefined;
  if (raw !== undefined) {
    try {
      backupPath = await rotateBackups(ports, path, raw);
    } catch (error) {
      return { kind: "write-failed", stage: "rotate-backups", error: errorMessage(error), fileState: "untouched" };
    }
  }

  const modelIds = input.models.map((m) => m.id);

  try {
    await ports.writeFile(path, JSON.stringify(merged, null, 2));
  } catch (error) {
    // A rejecting main write can still leave `path` partially written by a
    // non-atomic port (see WriterPorts.writeFile's atomicity contract, D) —
    // attempt a restore rather than trust whatever is now on disk (C).
    return recoverFromFailedWrite(ports, path, `main write failed: ${errorMessage(error)}`, backupPath);
  }

  let verification: { ok: true } | { ok: false; error: string };
  try {
    verification = await ports.verifyWritten(providerKey, modelIds);
  } catch (error) {
    verification = { ok: false, error: `verifyWritten threw: ${errorMessage(error)}` };
  }

  if (!verification.ok) {
    return recoverFromFailedWrite(ports, path, verification.error, backupPath);
  }

  return { kind: "written", backup: backupPath, lint: lintWarnings };
}

export interface PruneRemoval {
  providerKey: string;
  modelIds: string[];
}

/**
 * Removes the confirmed Unserved Models for one or more Providers through
 * the same guarded orchestration as `commit()` (D-001): read → comment guard
 * → remove (never touches any other field or model) → mirror validate →
 * backup rotate → write → verify → restore on failure. `removals` may span
 * multiple Providers so a single prune run still produces exactly ONE
 * backup and ONE write (spec R2: "one confirmation... a backup is written
 * before any change"). `verifyWritten` is called with an empty providerKey
 * and empty modelIds — the generic "did the file still load" check the spec
 * requires for every write (R2's read-back requirement), not add()'s
 * stronger per-model-presence check: proving specific models are now ABSENT
 * would hold just as well on a totally broken read, so it proves nothing
 * extra here.
 */
export async function commitPrune(ports: WriterPorts, path: string, removals: PruneRemoval[]): Promise<WriteOutcome> {
  let raw: string | undefined;
  try {
    raw = await ports.readFile(path);
  } catch (error) {
    return { kind: "write-failed", stage: "read", error: errorMessage(error), fileState: "untouched" };
  }

  if (raw === undefined) {
    // R2-007: models.json existed when the shell scanned it (that's how
    // `removals` got computed at all) but is gone now — NEVER report
    // `written` here, that would tell the caller Unserved Models were
    // removed when nothing was written at all. Reuse `invalid` (file
    // untouched, same recovery-hint shape as every other pre-write abort).
    return {
      kind: "invalid",
      errors: ["models.json no longer exists (deleted since the prune started)"],
      backups: await listBackupsSafely(ports, path),
    };
  }

  if (hasComments(raw)) {
    return { kind: "refused", reason: "comments" };
  }

  let existing: unknown;
  try {
    existing = JSON.parse(raw);
  } catch (error) {
    return {
      kind: "invalid",
      errors: [`existing models.json is not valid JSON: ${errorMessage(error)}`],
      backups: await listBackupsSafely(ports, path),
    };
  }

  let merged = asObject(existing);
  for (const removal of removals) {
    merged = removeModels(merged, removal.providerKey, removal.modelIds);
  }

  const validation = validate(merged);
  if (!validation.ok) {
    return { kind: "invalid", errors: validation.errors, backups: await listBackupsSafely(ports, path) };
  }

  const lintWarnings = lint(merged);

  let backupPath: string | undefined;
  try {
    backupPath = await rotateBackups(ports, path, raw);
  } catch (error) {
    return { kind: "write-failed", stage: "rotate-backups", error: errorMessage(error), fileState: "untouched" };
  }

  try {
    await ports.writeFile(path, JSON.stringify(merged, null, 2));
  } catch (error) {
    return recoverFromFailedWrite(ports, path, `main write failed: ${errorMessage(error)}`, backupPath);
  }

  let verification: { ok: true } | { ok: false; error: string };
  try {
    verification = await ports.verifyWritten("", []);
  } catch (error) {
    verification = { ok: false, error: `verifyWritten threw: ${errorMessage(error)}` };
  }

  if (!verification.ok) {
    return recoverFromFailedWrite(ports, path, verification.error, backupPath);
  }

  return { kind: "written", backup: backupPath, lint: lintWarnings };
}

/**
 * Runs the recovery path after a write is known to be bad (main write
 * rejected, or `verifyWritten` reported/threw a failure): restore the
 * newest backup, then honestly report what actually happened (B+F) —
 * `restored` (with a second `verifyWritten` per D3), `rolled-back` (no
 * backup existed), or `restore-failed` (the failed write is left in place).
 * If the restore machinery itself throws (C), that becomes a `write-failed`
 * outcome instead of escaping — the main write already landed in `path`,
 * unconfirmed, and recovery could not even be attempted.
 *
 * v0.1.1 hotfix item 2: the post-restore re-verify ALWAYS uses the generic
 * `verifyWritten("", [])` convention (see `WriterPorts.verifyWritten`'s
 * JSDoc) — never a specific-model check for the models the FAILED write was
 * trying to add. Those models were just rolled back by the restore above,
 * so they can never be found; checking for them here reported a false
 * "Restore verification failed" on every restore, even a byte-identical one
 * (the exact live E2E symptom this hotfix fixes).
 */
async function recoverFromFailedWrite(
  ports: WriterPorts,
  path: string,
  triggeringError: string,
  backupPath: string | undefined,
): Promise<WriteOutcome> {
  let restoreResult: RestoreResult;
  try {
    restoreResult = await restoreNewestBackup(ports, path);
  } catch (error) {
    return {
      kind: "write-failed",
      stage: "restore",
      error: `${triggeringError}; restore threw: ${errorMessage(error)}`,
      fileState: "unverified-write",
      backup: backupPath,
    };
  }

  if (restoreResult.status === "rolled-back-no-backup") {
    return { kind: "rolled-back", error: triggeringError };
  }

  if (restoreResult.status === "restore-failed") {
    return {
      kind: "restore-failed",
      path: restoreResult.path,
      reason: restoreResult.reason,
      error: triggeringError,
    };
  }

  // Successful restore (D3): refresh again and report that second
  // verification's result too — a successful restore is not itself proof
  // the restored content is good. A throwing re-verify is itself caught so
  // this final stage cannot leak an exception either. Generic check ("", []) —
  // see this function's JSDoc and WriterPorts.verifyWritten's contract.
  let verification: { ok: true } | { ok: false; error: string };
  try {
    verification = await ports.verifyWritten("", []);
  } catch (error) {
    verification = { ok: false, error: `verifyWritten threw: ${errorMessage(error)}` };
  }
  return { kind: "restored", path: restoreResult.path, error: triggeringError, verification };
}
