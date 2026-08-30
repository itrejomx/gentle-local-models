// Integration layer (D3, D-001): exercises `commit()` against a REAL
// filesystem under `os.tmpdir()`. Unlike models-writer.test.ts (stubbed
// WriterPorts), this proves the backup file actually lands on disk before
// any change, that a real round trip never overwrites an existing field, and
// that a verifyWritten failure genuinely restores the newest on-disk backup
// — never `~/.pi/agent/models.json`, never any gentle-ai file.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { commit, type WriterPorts } from "../extensions/local-models/models-writer.ts";

function realFsPorts(now: () => number, verify: WriterPorts["verifyWritten"]): WriterPorts {
  return {
    async readFile(path: string) {
      try {
        return await readFile(path, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    async writeFile(path: string, contents: string) {
      await writeFile(path, contents, "utf-8");
    },
    async deleteFile(path: string) {
      await unlink(path);
    },
    async listBackups(path: string) {
      const dir = dirname(path);
      const base = basename(path);
      const entries = await readdir(dir);
      return entries.filter((e) => e.startsWith(`${base}.`) && e.endsWith(".bak")).map((e) => join(dir, e));
    },
    now,
    verifyWritten: verify,
  };
}

const alwaysOk: WriterPorts["verifyWritten"] = async () => ({ ok: true });

let dir: string;
let modelsPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gentle-local-models-test-"));
  modelsPath = join(dir, "models.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("commit — real filesystem integration (D-001, D3)", () => {
  it("writes a models.json.<epoch>.bak backup to disk before changing an existing file", async () => {
    const original = JSON.stringify({ providers: { lmstudio: { models: [{ id: "m1", name: "m1" }] } } });
    await writeFile(modelsPath, original, "utf-8");
    const ports = realFsPorts(() => 1000, alwaysOk);

    const outcome = await commit(ports, modelsPath, "lmstudio", { models: [{ id: "m2" }] });

    expect(outcome.kind).toBe("written");
    const backupPath = `${modelsPath}.1000.bak`;
    const backupContents = await readFile(backupPath, "utf-8");
    expect(backupContents).toBe(original);
  });

  it("never overwrites an existing field on a real round trip through disk", async () => {
    const original = JSON.stringify({
      providers: { lmstudio: { models: [{ id: "m1", name: "m1", contextWindow: 131072 }] } },
    });
    await writeFile(modelsPath, original, "utf-8");
    const ports = realFsPorts(() => 2000, alwaysOk);

    await commit(ports, modelsPath, "lmstudio", { models: [{ id: "m1", contextWindow: 999999 }] });

    const finalContents = JSON.parse(await readFile(modelsPath, "utf-8"));
    expect(finalContents.providers.lmstudio.models[0].contextWindow).toBe(131072);
  });

  it("caps rotating backups at 10 real files on disk, pruning the oldest", async () => {
    await writeFile(modelsPath, JSON.stringify({ providers: {} }), "utf-8");
    for (let epoch = 1; epoch <= 10; epoch++) {
      await writeFile(`${modelsPath}.${epoch}.bak`, `pre-existing-backup-${epoch}`, "utf-8");
    }
    const ports = realFsPorts(() => 11, alwaysOk);

    await commit(ports, modelsPath, "lmstudio", { models: [{ id: "m1" }] });

    const entries = await readdir(dir);
    const backups = entries.filter((e) => e.endsWith(".bak"));
    expect(backups).toHaveLength(10);
    expect(backups).not.toContain("models.json.1.bak");
    expect(backups).toContain("models.json.11.bak");
  });

  it("auto-restores the newest on-disk backup when verifyWritten fails, leaving models.json as it was", async () => {
    const original = JSON.stringify({ providers: { lmstudio: { models: [{ id: "m1", name: "m1" }] } } });
    await writeFile(modelsPath, original, "utf-8");
    const failingVerify: WriterPorts["verifyWritten"] = async () => ({ ok: false, error: "empty provider map" });
    const ports = realFsPorts(() => 3000, failingVerify);

    const outcome = await commit(ports, modelsPath, "lmstudio", { models: [{ id: "m2" }] });

    expect(outcome).toEqual({ kind: "restored", backup: `${modelsPath}.3000.bak`, error: "empty provider map" });
    const restoredContents = await readFile(modelsPath, "utf-8");
    expect(restoredContents).toBe(original);
  });

  it("rolls back to 'no file' when verifyWritten fails on the very first write (no backup exists to restore)", async () => {
    const ports = realFsPorts(() => 4000, async () => ({ ok: false, error: "empty provider map" }));

    const outcome = await commit(ports, modelsPath, "lmstudio", { models: [{ id: "m1" }] });

    expect(outcome).toEqual({ kind: "restored", backup: "", error: "empty provider map" });
    await expect(readFile(modelsPath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
