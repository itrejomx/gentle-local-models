// Shell-only real port implementations (D1): binds the pure core modules'
// injected ports to Node's real filesystem and network. Never imported by
// any core module (detect/presets/context/state/models-writer) — only
// index.ts wires these in. `ctx` (Pi's ExtensionContext) never appears
// here; the one port that needs it (verifyWritten, via ctx.modelRegistry)
// stays in index.ts, the one file allowed to touch ctx (D1).

import { readFile as fsReadFile, readdir, rename, unlink, writeFile as fsWriteFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { WriterPorts } from "./models-writer.ts";
import type { StatePorts } from "./state.ts";
import type { ContextPorts, PropsFields, VModelsFields } from "./context.ts";
import type { FetchLike } from "./detect.ts";

export function modelsJsonPath(): string {
  return join(homedir(), ".pi", "agent", "models.json");
}

export function stateJsonPath(): string {
  return join(homedir(), ".pi", "agent", "gentle-local-models.json");
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

let tmpFileCounter = 0;

/**
 * Real WriterPorts bound to the real filesystem. `writeFile` copies the
 * write-temp + rename atomicity contract from
 * tests/models-writer.integration.test.ts's `realFsPorts` reference (D4,
 * WriterPorts.writeFile's JSDoc). R3-014: if `rename` itself fails, the
 * leftover temp file is best-effort cleaned up before the original error is
 * rethrown — cleanup failure is swallowed so it never masks the real error
 * that already needs reporting.
 */
export function realWriterPorts(verifyWritten: WriterPorts["verifyWritten"]): WriterPorts {
  return {
    async readFile(path) {
      try {
        return await fsReadFile(path, "utf-8");
      } catch (error) {
        if (isEnoent(error)) {
          return undefined;
        }
        throw error;
      }
    },
    async writeFile(path, contents) {
      const tmpPath = `${path}.tmp-${process.pid}-${tmpFileCounter++}`;
      await fsWriteFile(tmpPath, contents, "utf-8");
      try {
        await rename(tmpPath, path);
      } catch (error) {
        try {
          await unlink(tmpPath);
        } catch {
          // Best-effort cleanup only (R3-014) — never mask the real rename error below.
        }
        throw error;
      }
    },
    async deleteFile(path) {
      await unlink(path);
    },
    async listBackups(path) {
      const dir = dirname(path);
      const base = basename(path);
      try {
        const entries = await readdir(dir);
        return entries.filter((entry) => entry.startsWith(`${base}.`) && entry.endsWith(".bak")).map((entry) => join(dir, entry));
      } catch (error) {
        if (isEnoent(error)) {
          return [];
        }
        throw error;
      }
    },
    now: () => Date.now(),
    verifyWritten,
  };
}

/** Real StatePorts bound to the real filesystem, at whatever path the caller binds (D-002). */
export function realStatePorts(path: string): StatePorts {
  return {
    async readState() {
      try {
        return await fsReadFile(path, "utf-8");
      } catch (error) {
        if (isEnoent(error)) {
          return undefined;
        }
        throw error;
      }
    },
    async writeState(contents) {
      await fsWriteFile(path, contents, "utf-8");
    },
  };
}

/**
 * Real ContextPorts.readLlamaSwapConfig. v0.1 has no live discovery of a
 * running llama-swap instance's own config path (that is R5/v0.2 territory,
 * per spec's scope header) — this binds a conventional default,
 * overridable via `LLAMA_SWAP_CONFIG_PATH`. R3-006: any fs error (missing
 * file, permission, ...) resolves to `undefined` rather than throwing — a
 * read failure here just means this source doesn't resolve, not a hard
 * error for `add`.
 */
export function realContextPorts(
  configPath: string = process.env.LLAMA_SWAP_CONFIG_PATH ?? join(homedir(), ".llama-swap", "config.yaml"),
): ContextPorts {
  return {
    async readLlamaSwapConfig() {
      try {
        return await fsReadFile(configPath, "utf-8");
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Real fetchVModels: re-fetches `{baseUrl}/models` and indexes entries by
 * id, extracting only the fields context.resolve's source (1) reads
 * (max_model_len, context_length, meta.context_length). Any fetch/parse
 * failure resolves to an empty map — this source simply doesn't resolve,
 * matching context.resolve's own no-throw contract.
 */
export function realFetchVModels(fetchFn: FetchLike): (baseUrl: string) => Promise<Record<string, VModelsFields>> {
  return async (baseUrl: string) => {
    try {
      const response = await fetchFn(`${baseUrl}/models`);
      if (!response.ok) {
        return {};
      }
      const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
      const out: Record<string, VModelsFields> = {};
      for (const entry of body.data ?? []) {
        if (typeof entry.id !== "string") {
          continue;
        }
        const meta = entry.meta;
        const metaContextLength =
          typeof meta === "object" && meta !== null && typeof (meta as Record<string, unknown>).context_length === "number"
            ? ((meta as Record<string, unknown>).context_length as number)
            : undefined;
        out[entry.id] = {
          max_model_len: typeof entry.max_model_len === "number" ? entry.max_model_len : undefined,
          context_length: typeof entry.context_length === "number" ? entry.context_length : undefined,
          meta: metaContextLength !== undefined ? { context_length: metaContextLength } : undefined,
        };
      }
      return out;
    } catch {
      return {};
    }
  };
}

/** Real fetchProps: GETs `{origin}/props` (llama.cpp-family servers expose this unversioned, not under /v1). */
export function realFetchProps(fetchFn: FetchLike): (baseUrl: string) => Promise<PropsFields | undefined> {
  return async (baseUrl: string) => {
    try {
      const origin = new URL(baseUrl).origin;
      const response = await fetchFn(`${origin}/props`);
      if (!response.ok) {
        return undefined;
      }
      return (await response.json()) as PropsFields;
    } catch {
      return undefined;
    }
  };
}
