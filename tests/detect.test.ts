import { describe, expect, it, vi } from "vitest";
import { normalize, probe, probeAll, type FetchLike } from "../extensions/local-models/detect.ts";

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

  it("treats a 200 response with zero models as a failure, not a success", async () => {
    const fetchFn: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    })) as unknown as FetchLike;

    const result = await probe(fetchFn, "http://localhost:8080/v1");

    expect(result.status).toBe("unreachable");
    expect(result).toMatchObject({ baseUrl: "http://localhost:8080/v1" });
    if (result.status === "unreachable") {
      expect(result.error).toMatch(/zero models/i);
    }
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
