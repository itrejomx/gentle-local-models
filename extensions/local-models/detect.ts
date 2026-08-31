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
  // v0.1.1 hotfix item 3a: the first valid model entry's declared `owned_by`
  // (llama-swap/mtplx/mlx-serve/omlx report their own kind here), used by
  // `add`'s kind auto-detect via presets.kindFromOwnedBy. Undefined when no
  // entry declares it.
  ownedBy?: string;
}

/**
 * The Server RESPONDED (HTTP 200) but currently reports zero models. Kept
 * distinct from `ProbeUnreachable` (R1-006/R3-021): per the glossary, an
 * Unserved Model is one its Server "no longer reports" — which presumes the
 * Server responded at all. A connection failure/timeout/non-200 means the
 * Server said nothing, and callers (`prune`, in particular) must not treat
 * silence as "reports zero models".
 */
export interface ProbeEmpty {
  status: "empty";
  baseUrl: string;
  models: [];
}

export interface ProbeUnreachable {
  status: "unreachable";
  baseUrl: string;
  error: string;
}

export type ProbeResult = ProbeReachable | ProbeEmpty | ProbeUnreachable;

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
 * HTTP 200 with zero (or all-invalid, R3-003) models reports its own
 * `empty` status — the Server responded, it just has nothing to report right
 * now — kept distinct from `unreachable` (non-200, connection failure, or
 * timeout: the Server never usefully responded at all; R1-006/R3-021).
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

    const body = (await response.json()) as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
    // R3-003: a semi-conformant /v1/models can return entries with no (or a
    // non-string) `id`; filter those out rather than reporting a garbage id
    // as a real model. An all-invalid list is treated as zero models below.
    const validEntries = Array.isArray(body?.data)
      ? body.data.filter((entry): entry is { id: string; owned_by?: unknown } => typeof entry?.id === "string")
      : [];
    const models = validEntries.map((entry) => entry.id);

    if (models.length === 0) {
      return { status: "empty", baseUrl, models: [] };
    }

    // v0.1.1 hotfix item 3a: the first entry that declares owned_by wins —
    // every known Server kind reports the same value on every model it serves.
    const ownedByEntry = validEntries.find((entry) => typeof entry.owned_by === "string");
    const ownedBy = ownedByEntry?.owned_by as string | undefined;

    return { status: "reachable", baseUrl, models, ownedBy };
  } catch (err) {
    return { status: "unreachable", baseUrl, error: errorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/**
 * True when `baseUrl`'s hostname is a loopback/local-machine address
 * (localhost, 127.0.0.1, 0.0.0.0, ::1). Used by `prune` (Phase 8, D4) to
 * scope "any local Provider" — a LAN or remote hostname is NOT local by this
 * test (design.md's Open Questions: host-based, acceptable for v0.1, revisit
 * in v0.2). An unparsable `baseUrl` resolves to `false` rather than throwing.
 */
export function isLocalHost(baseUrl: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(baseUrl).hostname);
  } catch {
    return false;
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
