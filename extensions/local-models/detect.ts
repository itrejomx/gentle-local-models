// Pure core module — no `ctx` import, no Pi runtime dependency.
// fetch is injected as a port so the module stays testable and side-effect-free.

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface ProbeReachable {
  status: "reachable";
  baseUrl: string;
  models: string[];
}

export interface ProbeUnreachable {
  status: "unreachable";
  baseUrl: string;
  error: string;
}

export type ProbeResult = ProbeReachable | ProbeUnreachable;

const DEFAULT_TIMEOUT_MS = 1000;

/**
 * Normalizes a Server base URL input, accepting `host:port`, a trailing
 * `/v1`, or a trailing `/v1/`. All three forms resolve to the same
 * normalized base URL, always ending in `/v1`.
 */
export function normalize(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `http://${input}`;
  const url = new URL(withScheme);

  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/v1")) {
    pathname = pathname.slice(0, -"/v1".length);
  }

  return `${url.origin}${pathname}/v1`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Probes `GET {baseUrl}/models` with a timeout (default 1 s, per spec).
 * HTTP 200 with zero models is treated as a failure, not a success.
 * Unreachable/timed-out probes report failure with the last error preserved.
 */
export async function probe(
  fetchFn: FetchLike,
  baseUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(`${baseUrl}/models`, { signal: controller.signal });

    if (!response.ok) {
      return { status: "unreachable", baseUrl, error: `HTTP ${response.status}` };
    }

    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    // R3-003: a semi-conformant /v1/models can return entries with no (or a
    // non-string) `id`; filter those out rather than reporting a garbage id
    // as a real model. An all-invalid list is treated as zero models below.
    const models = Array.isArray(body?.data)
      ? body.data.filter((model): model is { id: string } => typeof model?.id === "string").map((model) => model.id)
      : [];

    if (models.length === 0) {
      return { status: "unreachable", baseUrl, error: "reachable but reported zero models" };
    }

    return { status: "reachable", baseUrl, models };
  } catch (err) {
    return { status: "unreachable", baseUrl, error: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes every given base URL independently. Callers (the shell, Phase 8)
 * decide WHICH base URLs to pass in — this stays a pure primitive with no
 * Provider/state enumeration of its own.
 */
export async function probeAll(
  fetchFn: FetchLike,
  baseUrls: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProbeResult[]> {
  return Promise.all(baseUrls.map((baseUrl) => probe(fetchFn, baseUrl, timeoutMs)));
}
