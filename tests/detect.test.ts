import { describe, expect, it, vi } from "vitest";
import { isLocalHost, normalize, probe, probeAll, type FetchLike } from "../extensions/local-models/detect.ts";

describe("normalize", () => {
  it("normalizes a bare host:port to a base URL ending in /v1", () => {
    expect(normalize("localhost:11234")).toBe("http://localhost:11234/v1");
  });

  it("normalizes host:port/v1 to the same base URL", () => {
    expect(normalize("localhost:11234/v1")).toBe("http://localhost:11234/v1");
  });

  it("normalizes host:port/v1/ (trailing slash) to the same base URL", () => {
    expect(normalize("localhost:11234/v1/")).toBe("http://localhost:11234/v1");
  });
});

describe("probe", () => {
  it("reports reachable when /v1/models responds 200 with models", async () => {
    const fetchFn: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "qwen3-4b" }, { id: "glm-4.5-air" }] }),
    })) as unknown as FetchLike;

    const result = await probe(fetchFn, "http://localhost:11234/v1");

    expect(result).toEqual({
      status: "reachable",
      baseUrl: "http://localhost:11234/v1",
      models: ["qwen3-4b", "glm-4.5-air"],
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "http://localhost:11234/v1/models",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("captures owned_by from the first entry that declares it, for add's kind auto-detect (v0.1.1 hotfix item 3a)", async () => {
    const fetchFn: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "qwen3-4b", owned_by: "llama-swap" }, { id: "glm-4.5-air" }] }),
    })) as unknown as FetchLike;

    const result = await probe(fetchFn, "http://localhost:8080/v1");

    expect(result).toMatchObject({ status: "reachable", ownedBy: "llama-swap" });
  });

  it("leaves ownedBy undefined when no entry declares it", async () => {
    const fetchFn: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "qwen3-4b" }] }),
    })) as unknown as FetchLike;

    const result = await probe(fetchFn, "http://localhost:8080/v1");

    expect(result).toEqual({ status: "reachable", baseUrl: "http://localhost:8080/v1", models: ["qwen3-4b"] });
  });

  it("filters out model entries without a string id (semi-conformant /v1/models), keeping only valid ones (R3-003)", async () => {
    const fetchFn: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "qwen3-4b" }, {}, { id: 42 }, { id: "glm-4.5-air" }] }),
    })) as unknown as FetchLike;

    const result = await probe(fetchFn, "http://localhost:11234/v1");

    expect(result).toEqual({
      status: "reachable",
      baseUrl: "http://localhost:11234/v1",
      models: ["qwen3-4b", "glm-4.5-air"],
    });
  });

  it("treats a response where every model entry is invalid as its own 'empty' status, not 'unreachable' (R1-006/R3-021)", async () => {
    const fetchFn: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{}, { id: 42 }, { name: "no id field" }] }),
    })) as unknown as FetchLike;

    const result = await probe(fetchFn, "http://localhost:11234/v1");

    expect(result).toEqual({ status: "empty", baseUrl: "http://localhost:11234/v1", models: [] });
  });

  it("reports a 200 response with zero models as 'empty' — the Server responded, distinct from 'unreachable' (R1-006/R3-021)", async () => {
    const fetchFn: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    })) as unknown as FetchLike;

    const result = await probe(fetchFn, "http://localhost:8080/v1");

    expect(result).toEqual({ status: "empty", baseUrl: "http://localhost:8080/v1", models: [] });
  });

  it("keeps a non-200 response as 'unreachable' (the Server did not usefully respond)", async () => {
    const fetchFn: FetchLike = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as FetchLike;

    const result = await probe(fetchFn, "http://localhost:8080/v1");

    expect(result).toEqual({ status: "unreachable", baseUrl: "http://localhost:8080/v1", error: "HTTP 500" });
  });

  it("reports unreachable with the last error when the Server rejects", async () => {
    const fetchFn: FetchLike = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchLike;

    const result = await probe(fetchFn, "http://localhost:9999/v1");

    expect(result).toEqual({
      status: "unreachable",
      baseUrl: "http://localhost:9999/v1",
      error: "ECONNREFUSED",
    });
  });

  it("aborts and reports unreachable when the Server does not respond within the timeout", async () => {
    const fetchFn: FetchLike = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as FetchLike;

    const start = Date.now();
    const result = await probe(fetchFn, "http://localhost:11235/v1", 50);
    const elapsed = Date.now() - start;

    expect(result.status).toBe("unreachable");
    expect(elapsed).toBeLessThan(300);
  });
});

describe("isLocalHost", () => {
  it("treats localhost, 127.0.0.1, 0.0.0.0, and ::1 as local (Phase 8, prune's 'any local Provider' test)", () => {
    expect(isLocalHost("http://localhost:11234/v1")).toBe(true);
    expect(isLocalHost("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isLocalHost("http://0.0.0.0:8080/v1")).toBe(true);
    expect(isLocalHost("http://[::1]:8080/v1")).toBe(true);
  });

  it("treats a LAN or remote hostname as NOT local (design.md Open Questions: acceptable for v0.1)", () => {
    expect(isLocalHost("http://192.168.1.50:8080/v1")).toBe(false);
    expect(isLocalHost("https://models.example.com/v1")).toBe(false);
  });

  it("treats an unparsable baseUrl as NOT local rather than throwing", () => {
    expect(isLocalHost("not a url")).toBe(false);
  });
});

describe("probeAll", () => {
  it("probes every given base URL independently and preserves per-URL results", async () => {
    const fetchFn: FetchLike = vi.fn(async (url: string) => {
      if (url.includes("11234")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "qwen3-4b" }] }),
        };
      }
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchLike;

    const results = await probeAll(fetchFn, [
      "http://localhost:11234/v1",
      "http://localhost:9999/v1",
    ]);

    expect(results).toEqual([
      { status: "reachable", baseUrl: "http://localhost:11234/v1", models: ["qwen3-4b"] },
      { status: "unreachable", baseUrl: "http://localhost:9999/v1", error: "ECONNREFUSED" },
    ]);
  });
});
