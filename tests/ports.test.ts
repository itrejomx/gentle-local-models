// R4-005: realFetchVModels/realFetchProps are cold metadata reads (D-005's
// context sources) — bounded by a timeout so a half-dead Server can never
// hang `add()` indefinitely, matching detect.ts's probe() pattern but more
// lenient (default 5s vs. probe's 1s) since these reads aren't reachability
// checks.

import { describe, expect, it, vi } from "vitest";
import { realFetchProps, realFetchVModels } from "../extensions/local-models/ports.ts";
import type { FetchLike } from "../extensions/local-models/detect.ts";

/** A fetch stub that never resolves on its own — only rejects if the caller's AbortSignal fires. */
function neverResolvingFetch(): FetchLike {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }) as unknown as FetchLike;
}

describe("realFetchVModels — bounded timeout (R4-005)", () => {
  it("resolves to an empty map within the timeout when the Server never responds", async () => {
    const fetchFn = neverResolvingFetch();
    const start = Date.now();

    const result = await realFetchVModels(fetchFn, 50)("http://localhost:11234/v1");

    const elapsed = Date.now() - start;
    expect(result).toEqual({});
    expect(elapsed).toBeLessThan(500);
  });
});

describe("realFetchProps — bounded timeout (R4-005)", () => {
  it("resolves to undefined within the timeout when the Server never responds", async () => {
    const fetchFn = neverResolvingFetch();
    const start = Date.now();

    const result = await realFetchProps(fetchFn, 50)("http://localhost:11234/v1");

    const elapsed = Date.now() - start;
    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(500);
  });
});
