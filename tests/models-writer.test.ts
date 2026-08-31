import { describe, expect, it, vi } from "vitest";
import {
  hasComments,
  mergeProvider,
  validate,
  lint,
  rotateBackups,
  commit,
  commitPrune,
  type ProviderInput,
  type WriterPorts,
} from "../extensions/local-models/models-writer.ts";

function memoryPorts(
  files: Record<string, string> = {},
  options: { now?: number; verify?: WriterPorts["verifyWritten"] } = {},
): WriterPorts & { files: Record<string, string> } {
  return {
    files,
    async readFile(path: string) {
      return files[path];
    },
    async writeFile(path: string, contents: string) {
      files[path] = contents;
    },
    async deleteFile(path: string) {
      delete files[path];
    },
    async listBackups(path: string) {
      const prefix = `${path}.`;
      return Object.keys(files).filter((p) => p.startsWith(prefix) && p.endsWith(".bak"));
    },
    now: () => options.now ?? 0,
    verifyWritten: options.verify ?? (async () => ({ ok: true as const })),
  };
}

// Realistic hand-curated lmstudio Provider block (17 models), all sharing the
// same contextWindow (262144) — the exact shape the plugin will merge against
// on a re-`add` of a Server the user already fully configured by hand.
const REALISTIC_LMSTUDIO_MODELS = [
  { id: "qwen/qwen3-4b-instruct-2507", name: "Qwen3 4B Instruct (2507)", reasoning: false },
  { id: "qwen/qwen3-4b-thinking-2507", name: "Qwen3 4B Thinking (2507)", reasoning: true, thinkingFormat: "qwen" },
  { id: "qwen/qwen3-8b", name: "Qwen3 8B", reasoning: true, thinkingFormat: "qwen" },
  { id: "qwen/qwen3-14b", name: "Qwen3 14B", reasoning: true, thinkingFormat: "qwen" },
  { id: "qwen/qwen3-30b-a3b", name: "Qwen3 30B A3B (MoE)", reasoning: true, thinkingFormat: "qwen" },
  { id: "qwen/qwen2.5-coder-7b-instruct", name: "Qwen2.5 Coder 7B Instruct", reasoning: false },
  { id: "zai-org/glm-4.7-flash", name: "GLM-4.7 Flash", reasoning: true, thinkingFormat: "zai" },
  { id: "zai-org/glm-4.7-air", name: "GLM-4.7 Air", reasoning: true, thinkingFormat: "zai" },
  { id: "zai-org/glm-4.5-air", name: "GLM-4.5 Air", reasoning: true, thinkingFormat: "zai" },
  {
    id: "deepseek-ai/deepseek-r1-distill-qwen-7b",
    name: "DeepSeek R1 Distill Qwen 7B",
    reasoning: true,
    thinkingFormat: "deepseek",
  },
  { id: "deepseek-ai/deepseek-coder-v2-lite-instruct", name: "DeepSeek Coder V2 Lite Instruct", reasoning: false },
  { id: "mistralai/mistral-7b-instruct-v0.3", name: "Mistral 7B Instruct v0.3", reasoning: false },
  { id: "mistralai/mixtral-8x7b-instruct-v0.1", name: "Mixtral 8x7B Instruct v0.1", reasoning: false },
  { id: "meta-llama/llama-3.1-8b-instruct", name: "Llama 3.1 8B Instruct", reasoning: false },
  { id: "meta-llama/llama-3.2-3b-instruct", name: "Llama 3.2 3B Instruct", reasoning: false },
  { id: "microsoft/phi-4-mini-instruct", name: "Phi-4 Mini Instruct", reasoning: false },
  { id: "google/gemma-2-9b-it", name: "Gemma 2 9B IT", reasoning: false },
] as const;

function realisticLmstudioFile(): { providers: Record<string, unknown> } {
  return {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "lm-studio",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
        models: REALISTIC_LMSTUDIO_MODELS.map((m) => ({
          id: m.id,
          name: m.name,
          contextWindow: 262144,
          maxTokens: 8192,
          reasoning: m.reasoning,
          ...("thinkingFormat" in m ? { compat: { thinkingFormat: m.thinkingFormat } } : {}),
        })),
      },
    },
  };
}

describe("hasComments — refuses to write over hand-edited files with comments (R2)", () => {
  it("returns false for clean JSON, including URLs with // inside string values", () => {
    const raw = JSON.stringify({ providers: { x: { baseUrl: "http://localhost:1234/v1" } } });
    expect(hasComments(raw)).toBe(false);
  });

  it("detects a line comment outside any string", () => {
    const raw = '{\n  // a note from the user\n  "providers": {}\n}';
    expect(hasComments(raw)).toBe(true);
  });

  it("detects a block comment outside any string", () => {
    const raw = '{\n  /* a note from the user */\n  "providers": {}\n}';
    expect(hasComments(raw)).toBe(true);
  });
});

describe("mergeProvider — fill-never-overwrite (R2)", () => {
  it("creates a brand new Provider with new models added, name = id, conservative maxTokens default", () => {
    const input: ProviderInput = {
      baseUrl: "http://localhost:11234/v1",
      apiKey: "local",
      models: [{ id: "qwen3-4b" }],
    };

    const merged = mergeProvider({}, "mlx-serve-local", input) as {
      providers: { "mlx-serve-local": { baseUrl: string; apiKey: string; models: Array<Record<string, unknown>> } };
    };

    expect(merged.providers["mlx-serve-local"].baseUrl).toBe("http://localhost:11234/v1");
    expect(merged.providers["mlx-serve-local"].models).toEqual([
      { id: "qwen3-4b", name: "qwen3-4b", maxTokens: 4096 },
    ]);
  });

  it("sets api on a brand new Provider so Pi's provider composer can resolve it (v0.1.1 hotfix item 1)", () => {
    const input: ProviderInput = {
      baseUrl: "http://localhost:11234/v1",
      apiKey: "local",
      models: [{ id: "qwen3-4b" }],
    };

    const merged = mergeProvider({}, "mlx-serve-local", input) as {
      providers: { "mlx-serve-local": { api?: string } };
    };

    expect(merged.providers["mlx-serve-local"].api).toBe("openai-completions");
  });

  it("fills api on an existing Provider that is missing it too — self-heals a pre-v0.1.1 write (rider batch item 1)", () => {
    const existing = {
      providers: {
        "mlx-serve-local": {
          baseUrl: "http://localhost:11234/v1",
          models: [{ id: "qwen3-4b", name: "qwen3-4b" }],
        },
      },
    };
    const input: ProviderInput = { models: [{ id: "qwen3-4b" }] };

    const merged = mergeProvider(existing, "mlx-serve-local", input) as {
      providers: { "mlx-serve-local": { api?: string } };
    };

    expect(merged.providers["mlx-serve-local"].api).toBe("openai-completions");
  });

  it("never overwrites an existing Provider's explicit api with the default", () => {
    const existing = {
      providers: {
        lmstudio: { baseUrl: "http://localhost:1234/v1", api: "anthropic-messages", models: [] },
      },
    };
    const input: ProviderInput = { baseUrl: "http://localhost:1234/v1", models: [] };

    const merged = mergeProvider(existing, "lmstudio", input) as {
      providers: { lmstudio: { api: string } };
    };

    expect(merged.providers.lmstudio.api).toBe("anthropic-messages");
  });

  it("preserves an existing contextWindow and fills a missing maxTokens with a conservative default", () => {
    const existing = {
      providers: {
        "mlx-serve-local": {
          baseUrl: "http://localhost:11234/v1",
          models: [{ id: "qwen3-4b", name: "qwen3-4b", contextWindow: 131072 }],
        },
      },
    };
    const input: ProviderInput = {
      models: [{ id: "qwen3-4b", contextWindow: 999, maxTokens: 2048 }],
    };

    const merged = mergeProvider(existing, "mlx-serve-local", input) as {
      providers: { "mlx-serve-local": { models: Array<{ contextWindow: number; maxTokens: number }> } };
    };

    expect(merged.providers["mlx-serve-local"].models[0].contextWindow).toBe(131072);
    expect(merged.providers["mlx-serve-local"].models[0].maxTokens).toBe(2048);
  });

  it("never overwrites existing Provider-level baseUrl/apiKey/compat", () => {
    const existing = {
      providers: {
        "llama-swap-local": {
          baseUrl: "http://localhost:8080/v1",
          apiKey: "original-key",
          compat: { supportsDeveloperRole: true, supportsReasoningEffort: true, maxTokensField: "max_tokens" },
          models: [],
        },
      },
    };
    const input: ProviderInput = {
      baseUrl: "http://different-host:9999/v1",
      apiKey: "new-key",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_completion_tokens" },
      models: [],
    };

    const merged = mergeProvider(existing, "llama-swap-local", input) as {
      providers: {
        "llama-swap-local": { baseUrl: string; apiKey: string; compat: { supportsDeveloperRole: boolean } };
      };
    };

    expect(merged.providers["llama-swap-local"].baseUrl).toBe("http://localhost:8080/v1");
    expect(merged.providers["llama-swap-local"].apiKey).toBe("original-key");
    expect(merged.providers["llama-swap-local"].compat.supportsDeveloperRole).toBe(true);
  });

  it("keeps a Model no longer reported by its Server as an Unserved Model (not removed)", () => {
    const existing = {
      providers: {
        "mlx-serve-local": {
          models: [
            { id: "qwen3-4b", name: "qwen3-4b" },
            { id: "retired-model", name: "retired-model" },
          ],
        },
      },
    };
    const input: ProviderInput = { models: [{ id: "qwen3-4b" }] };

    const merged = mergeProvider(existing, "mlx-serve-local", input) as {
      providers: { "mlx-serve-local": { models: Array<{ id: string }> } };
    };

    expect(merged.providers["mlx-serve-local"].models.map((m) => m.id)).toEqual(["qwen3-4b", "retired-model"]);
  });

  it("fill-never-overwrite against a realistic 17-model hand-curated lmstudio block: nothing changes, one new model is added", () => {
    const existing = realisticLmstudioFile();
    const input: ProviderInput = {
      models: [
        // Re-probing the same Server proposes DIFFERENT values than what the
        // user already curated — none of it should stick.
        ...REALISTIC_LMSTUDIO_MODELS.map((m) => ({ id: m.id, contextWindow: 4096, maxTokens: 256 })),
        { id: "qwen/qwen3-32b", contextWindow: 262144 }, // genuinely new, 18th model
      ],
    };

    const merged = mergeProvider(existing, "lmstudio", input) as {
      providers: { lmstudio: { models: Array<Record<string, unknown>> } };
    };
    const models = merged.providers.lmstudio.models;

    expect(models).toHaveLength(18);
    // All 17 pre-existing entries are byte-for-byte identical to the fixture.
    for (const original of (existing.providers.lmstudio as { models: unknown[] }).models) {
      expect(models).toContainEqual(original);
    }
    // The 18th, genuinely new model was added with conservative defaults.
    expect(models).toContainEqual({ id: "qwen/qwen3-32b", name: "qwen/qwen3-32b", contextWindow: 262144, maxTokens: 4096 });
  });

  it("fills Provider-level headers/authHeader when missing (Phase 7 mtplx/omlx per-kind extras)", () => {
    const input: ProviderInput = {
      baseUrl: "http://localhost:8000/v1",
      apiKey: "local",
      headers: { "x-mtplx-client": "pi" },
      models: [],
    };

    const merged = mergeProvider({}, "mtplx", input) as {
      providers: { mtplx: { headers: Record<string, string> } };
    };

    expect(merged.providers.mtplx.headers).toEqual({ "x-mtplx-client": "pi" });
  });

  it("never overwrites an existing headers/authHeader block", () => {
    const existing = {
      providers: {
        omlx: { authHeader: false, headers: { "x-custom": "kept" }, models: [] },
      },
    };
    const input: ProviderInput = {
      authHeader: true,
      headers: { "x-custom": "new" },
      models: [],
    };

    const merged = mergeProvider(existing, "omlx", input) as {
      providers: { omlx: { authHeader: boolean; headers: Record<string, string> } };
    };

    expect(merged.providers.omlx.authHeader).toBe(false);
    expect(merged.providers.omlx.headers).toEqual({ "x-custom": "kept" });
  });
});

describe("validate — pre-write mirrored-schema validation (R2)", () => {
  it("passes a well-formed models.json", () => {
    const result = validate(realisticLmstudioFile());
    expect(result).toEqual({ ok: true });
  });

  it("blocks a merge result with a Model missing its required id", () => {
    const bad = { providers: { lmstudio: { models: [{ name: "no id here" }] } } };

    const result = validate(bad);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("blocks a merge result whose top-level providers field is not an object", () => {
    const bad = { providers: "not-an-object" };

    const result = validate(bad);

    expect(result.ok).toBe(false);
  });

  it("accepts a Provider carrying headers and authHeader (mtplx/omlx per-kind extras)", () => {
    const file = {
      providers: {
        mtplx: { baseUrl: "http://localhost:8000/v1", apiKey: "local", headers: { "x-mtplx-client": "pi" }, models: [] },
        omlx: { authHeader: true, models: [] },
      },
    };

    expect(validate(file)).toEqual({ ok: true });
  });
});

describe("validate — strict api requirement for a plugin-authored NEW Provider (v0.1.1 hotfix item 1)", () => {
  it("rejects a plugin-built provider input missing api at both the provider and model level", () => {
    const file = { providers: { "mlx-serve-local": { models: [{ id: "qwen3-4b", name: "qwen3-4b" }] } } };

    const result = validate(file, ["mlx-serve-local"]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("api"))).toBe(true);
    }
  });

  it("accepts when the provider carries api", () => {
    const file = {
      providers: { "mlx-serve-local": { api: "openai-completions", models: [{ id: "qwen3-4b", name: "qwen3-4b" }] } },
    };

    expect(validate(file, ["mlx-serve-local"])).toEqual({ ok: true });
  });

  it("accepts when every model carries its own api even without a provider-level api", () => {
    const file = {
      providers: {
        "mlx-serve-local": { models: [{ id: "qwen3-4b", name: "qwen3-4b", api: "openai-completions" }] },
      },
    };

    expect(validate(file, ["mlx-serve-local"])).toEqual({ ok: true });
  });

  it("stays permissive for a Provider not listed in strictNewProviderKeys, even if it lacks api entirely", () => {
    const file = realisticLmstudioFile(); // no `api` field anywhere in this fixture

    expect(validate(file, [])).toEqual({ ok: true });
    expect(validate(file)).toEqual({ ok: true });
  });
});

describe("lint — compat-key lint warns without blocking (R2)", () => {
  it("returns no warnings when every compat key is known", () => {
    const file = realisticLmstudioFile();
    expect(lint(file)).toEqual([]);
  });

  it("warns on an unrecognized Provider-level compat key, and the file still validates", () => {
    const file = {
      providers: {
        lmstudio: {
          compat: { supportsDeveloperRole: true, notARealKey: true },
          models: [{ id: "m1", name: "m1" }],
        },
      },
    };

    const warnings = lint(file);

    expect(warnings.some((w) => w.includes("notARealKey"))).toBe(true);
    expect(validate(file)).toEqual({ ok: true });
  });

  it("warns on an unrecognized Model-level compat key without blocking the write", () => {
    const file = {
      providers: {
        lmstudio: {
          models: [{ id: "m1", name: "m1", compat: { thinkingFormat: "qwen", bogusKey: 1 } }],
        },
      },
    };

    const warnings = lint(file);

    expect(warnings.some((w) => w.includes("bogusKey"))).toBe(true);
    expect(validate(file)).toEqual({ ok: true });
  });

  // Regression for the second live E2E's false positive: Pi's real compat
  // schema (ProviderConfigSchema.compat / ModelDefinitionSchema.compat,
  // @earendil-works/pi-coding-agent@0.84.4's dist/core/model-config.d.ts)
  // accepts an IDENTICAL union of ~31 keys — including `thinkingFormat` — at
  // BOTH the Provider and Model level. A real lmstudio setup can legitimately
  // carry `thinkingFormat` on the Provider's own `compat` block, not only on
  // each Model's.
  it("does not warn on a Provider-level thinkingFormat (real lmstudio shape, Pi 0.84.4 compat schema)", () => {
    const file = {
      providers: {
        lmstudio: {
          compat: { supportsDeveloperRole: false, thinkingFormat: "qwen" },
          models: [{ id: "m1", name: "m1" }],
        },
      },
    };

    expect(lint(file)).toEqual([]);
  });

  it("still warns on a truly unknown Provider-level key (typo) alongside a legit thinkingFormat", () => {
    const file = {
      providers: {
        lmstudio: {
          compat: { thinkingFormat: "qwen", supportsDeveloperRol: false },
          models: [{ id: "m1", name: "m1" }],
        },
      },
    };

    const warnings = lint(file);

    expect(warnings.some((w) => w.includes("supportsDeveloperRol"))).toBe(true);
    expect(warnings.some((w) => w.includes("thinkingFormat"))).toBe(false);
  });

  it("still warns on a truly unknown Model-level key (typo)", () => {
    const file = {
      providers: {
        lmstudio: {
          models: [{ id: "m1", name: "m1", compat: { thinkingFormat: "qwen", supportsReasoningEfort: true } }],
        },
      },
    };

    const warnings = lint(file);

    expect(warnings.some((w) => w.includes("supportsReasoningEfort"))).toBe(true);
    expect(warnings.some((w) => w.includes("thinkingFormat"))).toBe(false);
  });

  it("the mirror TypeBox schema itself does not reject a Provider-level thinkingFormat", () => {
    const file = {
      providers: {
        lmstudio: {
          compat: { supportsDeveloperRole: false, thinkingFormat: "qwen" },
          models: [{ id: "m1", name: "m1" }],
        },
      },
    };

    expect(validate(file)).toEqual({ ok: true });
  });
});

describe("rotateBackups — rotation cap at 10 (R2)", () => {
  it("adds an 11th backup and prunes the oldest, keeping exactly 10", async () => {
    const path = "/fake/models.json";
    const existingBackups: Record<string, string> = {};
    for (let epoch = 1; epoch <= 10; epoch++) {
      existingBackups[`${path}.${epoch}.bak`] = `backup-${epoch}`;
    }
    const ports = memoryPorts(existingBackups, { now: 11 });

    const created = await rotateBackups(ports, path, "current-contents");

    expect(created).toBe(`${path}.11.bak`);
    const remaining = await ports.listBackups(path);
    expect(remaining).toHaveLength(10);
    expect(remaining).not.toContain(`${path}.1.bak`);
    expect(remaining).toContain(`${path}.11.bak`);
  });

  it("suffixes the backup path when two commits land in the same clock tick, preserving both pre-images", async () => {
    const path = "/fake/models.json";
    const ports = memoryPorts({}, { now: 100 });

    const first = await rotateBackups(ports, path, "pre-image-1");
    const second = await rotateBackups(ports, path, "pre-image-2");

    expect(first).toBe(`${path}.100.bak`);
    expect(second).toBe(`${path}.100-1.bak`);
    expect(await ports.readFile(first)).toBe("pre-image-1");
    expect(await ports.readFile(second)).toBe("pre-image-2");
    const remaining = await ports.listBackups(path);
    expect(remaining).toHaveLength(2);
  });

  it("counts both same-tick backups toward the rotation cap, still pruning the true oldest", async () => {
    const path = "/fake/models.json";
    const existingBackups: Record<string, string> = {};
    for (let epoch = 1; epoch <= 9; epoch++) {
      existingBackups[`${path}.${epoch}.bak`] = `backup-${epoch}`;
    }
    const ports = memoryPorts(existingBackups, { now: 100 });

    await rotateBackups(ports, path, "pre-image-1");
    await rotateBackups(ports, path, "pre-image-2");

    const remaining = await ports.listBackups(path);
    expect(remaining).toHaveLength(10);
    expect(remaining).toContain(`${path}.100.bak`);
    expect(remaining).toContain(`${path}.100-1.bak`);
    expect(remaining).not.toContain(`${path}.1.bak`);
  });
});

describe("commit — full orchestration against stubbed WriterPorts (R2)", () => {
  const path = "/fake/models.json";

  it("refuses and reports when the existing file contains comments", async () => {
    const ports = memoryPorts({ [path]: '{\n  // hand-added note\n  "providers": {}\n}' });

    const outcome = await commit(ports, path, "mlx-serve-local", { models: [{ id: "qwen3-4b" }] });

    expect(outcome).toEqual({ kind: "refused", reason: "comments" });
    expect(ports.files[path]).toBe('{\n  // hand-added note\n  "providers": {}\n}');
  });

  it("blocks the write when the resulting file fails mirrored-schema validation, leaving the file untouched", async () => {
    const corrupted = JSON.stringify({
      providers: { lmstudio: { models: [{ id: "m1", contextWindow: "not-a-number" }] } },
    });
    const ports = memoryPorts({ [path]: corrupted });

    const outcome = await commit(ports, path, "lmstudio", { models: [{ id: "m2" }] });

    expect(outcome).toMatchObject({ kind: "invalid", backups: [] });
    expect(ports.files[path]).toBe(corrupted);
  });

  it("surfaces available backup paths on an invalid outcome for a corrupted existing file, so the shell can offer recovery", async () => {
    const corrupted = JSON.stringify({
      providers: { lmstudio: { models: [{ id: "m1", contextWindow: "not-a-number" }] } },
    });
    const priorBackup = `${path}.10.bak`;
    const ports = memoryPorts({ [path]: corrupted, [priorBackup]: "an earlier good version" });

    const outcome = await commit(ports, path, "lmstudio", { models: [{ id: "m2" }] });

    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") {
      expect(outcome.backups).toEqual([priorBackup]);
    }
  });

  it("surfaces available backup paths on an invalid outcome for existing malformed JSON too", async () => {
    const priorBackup = `${path}.10.bak`;
    const ports = memoryPorts({ [path]: "{ not json", [priorBackup]: "an earlier good version" });

    const outcome = await commit(ports, path, "lmstudio", { models: [{ id: "m2" }] });

    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") {
      expect(outcome.backups).toEqual([priorBackup]);
    }
  });

  it("writes successfully and surfaces lint warnings for unknown compat keys without blocking", async () => {
    const ports = memoryPorts({});

    const outcome = await commit(ports, path, "lmstudio", {
      // Deliberately misspelled Provider-level key (typo: missing trailing "e").
      compat: { supportsDeveloperRol: false } as unknown as ProviderInput["compat"],
      models: [
        // Deliberately bogus Model-level key.
        { id: "m1", compat: { bogusKey: "qwen" } as unknown as ProviderInput["models"][number]["compat"] },
      ],
    });

    expect(outcome.kind).toBe("written");
    if (outcome.kind === "written") {
      expect(outcome.lint.some((w) => w.includes("supportsDeveloperRol"))).toBe(true);
      expect(outcome.lint.some((w) => w.includes("bogusKey"))).toBe(true);
    }
    expect(JSON.parse(ports.files[path]).providers.lmstudio.models[0].id).toBe("m1");
  });

  it("sets api on a brand-new Provider written via commit() (v0.1.1 hotfix item 1)", async () => {
    const ports = memoryPorts({});

    const outcome = await commit(ports, path, "mlx-serve-local", {
      baseUrl: "http://localhost:11234/v1",
      models: [{ id: "qwen3-4b" }],
    });

    expect(outcome.kind).toBe("written");
    const written = JSON.parse(ports.files[path]);
    expect(written.providers["mlx-serve-local"].api).toBe("openai-completions");
  });

  it("fills api on a re-added EXISTING api-less Provider, while every model stays byte-identical (rider batch item 1)", async () => {
    const existing = realisticLmstudioFile();
    const ports = memoryPorts({ [path]: JSON.stringify(existing) });

    const outcome = await commit(ports, path, "lmstudio", {
      models: REALISTIC_LMSTUDIO_MODELS.map((m) => ({ id: m.id, contextWindow: 4096, maxTokens: 256 })),
    });

    expect(outcome.kind).toBe("written");
    const written = JSON.parse(ports.files[path]);
    expect(written.providers.lmstudio.api).toBe("openai-completions");
    for (const original of (existing.providers.lmstudio as { models: unknown[] }).models) {
      expect(written.providers.lmstudio.models).toContainEqual(original);
    }
  });

  it("byte-preserves an existing Provider's api instead of overwriting it, when re-added via commit()", async () => {
    const existing = {
      providers: {
        lmstudio: { baseUrl: "http://localhost:1234/v1", api: "anthropic-messages", models: [] },
      },
    };
    const ports = memoryPorts({ [path]: JSON.stringify(existing) });

    const outcome = await commit(ports, path, "lmstudio", { baseUrl: "http://localhost:1234/v1", models: [] });

    expect(outcome.kind).toBe("written");
    const written = JSON.parse(ports.files[path]);
    expect(written.providers.lmstudio.api).toBe("anthropic-messages");
  });

  it("auto-restores the newest backup when verifyWritten reports an empty Provider map, naming the backup restored from", async () => {
    const original = JSON.stringify({ providers: { lmstudio: { models: [{ id: "m1", name: "m1" }] } } });
    const ports = memoryPorts({ [path]: original }, { now: 42, verify: async () => ({ ok: false, error: "empty provider map" }) });

    const outcome = await commit(ports, path, "lmstudio", { models: [{ id: "m2" }] });

    expect(outcome).toEqual({
      kind: "restored",
      path: `${path}.42.bak`,
      error: "empty provider map",
      verification: { ok: false, error: "empty provider map" },
    });
    expect(ports.files[path]).toBe(original);
  });

  it("re-verifies after a successful restore (D3: restore, refresh again, report) and calls verifyWritten twice", async () => {
    const original = JSON.stringify({ providers: { lmstudio: { models: [{ id: "m1", name: "m1" }] } } });
    let calls = 0;
    const verify: WriterPorts["verifyWritten"] = async () => {
      calls++;
      return calls === 1 ? { ok: false, error: "empty provider map" } : { ok: true };
    };
    const ports = memoryPorts({ [path]: original }, { now: 42, verify });

    const outcome = await commit(ports, path, "lmstudio", { models: [{ id: "m2" }] });

    expect(calls).toBe(2);
    expect(outcome).toEqual({
      kind: "restored",
      path: `${path}.42.bak`,
      error: "empty provider map",
      verification: { ok: true },
    });
    expect(ports.files[path]).toBe(original);
  });

  it("re-verifies a successful restore against the RESTORED file loading cleanly, not against the rolled-back models (v0.1.1 hotfix item 2)", async () => {
    // Reproduces the live E2E bug: after a genuinely perfect restore, the old
    // code re-called verifyWritten(providerKey, modelIds) for the NEW models
    // that were just rolled back — they can never be found post-restore, so
    // it always reported "Restore verification failed" even on a byte-
    // identical restore. The fix must re-verify with the generic ("", [])
    // "did the file load" check instead (the same convention commitPrune's
    // main-write verify already uses).
    const original = JSON.stringify({ providers: { lmstudio: { models: [{ id: "m1", name: "m1" }] } } });
    const verify: WriterPorts["verifyWritten"] = async (providerKey, modelIds) => {
      if (modelIds.length === 0) {
        return { ok: true };
      }
      return { ok: false, error: `model "${modelIds[0]}" not found in provider "${providerKey}" after refresh` };
    };
    const ports = memoryPorts({ [path]: original }, { now: 42, verify });

    const outcome = await commit(ports, path, "lmstudio", { models: [{ id: "m2" }] });

    expect(outcome).toEqual({
      kind: "restored",
      path: `${path}.42.bak`,
      error: 'model "m2" not found in provider "lmstudio" after refresh',
      verification: { ok: true },
    });
  });

  it("reports a distinct rolled-back-to-no-file variant, with no ambiguous backup sentinel, when no backup exists", async () => {
    const ports = memoryPorts({}, { now: 5, verify: async () => ({ ok: false, error: "empty provider map" }) });

    const outcome = await commit(ports, path, "lmstudio", { models: [{ id: "m1" }] });

    expect(outcome).toEqual({ kind: "rolled-back", error: "empty provider map" });
    expect(ports.files[path]).toBeUndefined();
  });

  it("reports restore-failed and leaves the failed write in place, honestly, when the newest backup is unreadable", async () => {
    const original = JSON.stringify({ providers: { lmstudio: { models: [{ id: "m1", name: "m1" }] } } });
    const backupPath = `${path}.42.bak`;
    const files: Record<string, string> = { [path]: original };
    const ports: WriterPorts & { files: Record<string, string> } = {
      files,
      async readFile(p: string) {
        if (p.endsWith(".bak")) {
          return undefined; // every backup is unreadable/corrupted
        }
        return files[p];
      },
      async writeFile(p: string, contents: string) {
        files[p] = contents;
      },
      async deleteFile(p: string) {
        delete files[p];
      },
      async listBackups() {
        return [backupPath];
      },
      now: () => 42,
      verifyWritten: async () => ({ ok: false, error: "empty provider map" }),
    };

    const outcome = await commit(ports, path, "lmstudio", { models: [{ id: "m2" }] });

    expect(outcome).toEqual({
      kind: "restore-failed",
      path: backupPath,
      reason: "backup file is unreadable",
      error: "empty provider map",
    });
    // The failed write is still there — honestly reported, not silently discarded.
    expect(JSON.parse(ports.files[path]).providers.lmstudio.models.map((m: { id: string }) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
  });

  it("never throws when the main write rejects — resolves to an outcome, attempting a restore", async () => {
    const original = JSON.stringify({ providers: { lmstudio: { models: [{ id: "m1", name: "m1" }] } } });
    const files: Record<string, string> = { [path]: original };
    let mainWriteAttempts = 0;
    const ports: WriterPorts & { files: Record<string, string> } = {
      files,
      async readFile(p: string) {
        return files[p];
      },
      async writeFile(p: string, contents: string) {
        // Only the main write to `path` fails ("disk full"); the backup
        // write and the later restore write-back both succeed normally.
        if (p === path) {
          mainWriteAttempts++;
          if (mainWriteAttempts === 1) {
            throw new Error("disk full");
          }
        }
        files[p] = contents;
      },
      async deleteFile(p: string) {
        delete files[p];
      },
      async listBackups(p: string) {
        const prefix = `${p}.`;
        return Object.keys(files).filter((k) => k.startsWith(prefix) && k.endsWith(".bak"));
      },
      now: () => 7,
      verifyWritten: async () => ({ ok: true }),
    };

    const outcome = await commit(ports, path, "lmstudio", { models: [{ id: "m2" }] });

    // No throw escaped commit() — a real outcome value came back, and the
    // pre-image backup taken before the failed write let us restore it.
    expect(outcome).toEqual({
      kind: "restored",
      path: `${path}.7.bak`,
      error: "main write failed: disk full",
      verification: { ok: true },
    });
    expect(ports.files[path]).toBe(original);
  });

  it("never throws when verifyWritten itself throws — resolves to an outcome, attempting a restore", async () => {
    const original = JSON.stringify({ providers: { lmstudio: { models: [{ id: "m1", name: "m1" }] } } });
    let calls = 0;
    const verify: WriterPorts["verifyWritten"] = async () => {
      calls++;
      if (calls === 1) {
        throw new Error("registry refresh crashed");
      }
      return { ok: true };
    };
    const ports = memoryPorts({ [path]: original }, { now: 9, verify });

    const outcome = await commit(ports, path, "lmstudio", { models: [{ id: "m2" }] });

    expect(outcome).toEqual({
      kind: "restored",
      path: `${path}.9.bak`,
      error: "verifyWritten threw: registry refresh crashed",
      verification: { ok: true },
    });
    expect(ports.files[path]).toBe(original);
  });
});

describe("commitPrune — full orchestration against stubbed WriterPorts (R2)", () => {
  const path = "/fake/models.json";

  it("reports an honest 'invalid' outcome — NEVER 'written' — when models.json no longer exists at write time (R2-007)", async () => {
    const priorBackup = `${path}.10.bak`;
    let readCalls = 0;
    const files: Record<string, string> = { [priorBackup]: "an earlier good version" };
    const ports: WriterPorts & { files: Record<string, string> } = {
      files,
      async readFile(p: string) {
        if (p === path) {
          readCalls++;
          // First call (the shell's pre-read): the file still exists.
          // Second call (commitPrune's own read): it's gone — deleted out
          // from under the prune between the initial scan and the write.
          return readCalls === 1 ? JSON.stringify({ providers: { mtplx: { models: [{ id: "gone" }] } } }) : undefined;
        }
        return files[p];
      },
      async writeFile(p: string, contents: string) {
        files[p] = contents;
      },
      async deleteFile(p: string) {
        delete files[p];
      },
      async listBackups() {
        return [priorBackup];
      },
      now: () => 42,
      verifyWritten: async () => ({ ok: true }),
    };
    // Simulate the shell's earlier pre-read already having happened.
    await ports.readFile(path);

    const outcome = await commitPrune(ports, path, [{ providerKey: "mtplx", modelIds: ["gone"] }]);

    expect(outcome).toEqual({
      kind: "invalid",
      errors: ["models.json no longer exists (deleted since the prune started)"],
      backups: [priorBackup],
    });
  });

  it("never calls writeFile when models.json is gone at write time", async () => {
    const writeFile = vi.fn(async () => {});
    const ports: WriterPorts = {
      async readFile() {
        return undefined;
      },
      writeFile,
      async deleteFile() {},
      async listBackups() {
        return [];
      },
      now: () => 1,
      verifyWritten: async () => ({ ok: true }),
    };

    await commitPrune(ports, path, [{ providerKey: "mtplx", modelIds: ["gone"] }]);

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("removes exactly the confirmed models and writes a single backup on a normal prune", async () => {
    const original = JSON.stringify({
      providers: { lmstudio: { models: [{ id: "m1", name: "m1" }, { id: "m2", name: "m2" }] } },
    });
    const ports = memoryPorts({ [path]: original }, { now: 5 });

    const outcome = await commitPrune(ports, path, [{ providerKey: "lmstudio", modelIds: ["m2"] }]);

    expect(outcome.kind).toBe("written");
    expect(JSON.parse(ports.files[path]).providers.lmstudio.models.map((m: { id: string }) => m.id)).toEqual(["m1"]);
    expect(ports.files[`${path}.5.bak`]).toBe(original);
  });
});
