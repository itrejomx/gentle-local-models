# Specification: server-registration (R1)

## Purpose
Register a local Server as a Pi Provider by URL, with reachability detection
and normalization.

## Requirements

### Requirement: Register and list Servers by URL
The system MUST provide `/local-models add <baseUrl>` and
`/local-models list`, registering a Server as a Provider without manual JSON
editing.

#### Scenario: Successful registration and listing
- GIVEN a reachable Server at a base URL, WHEN the user runs `add <baseUrl>`,
  THEN it is registered as a Provider and appears with its status in `list`.

### Requirement: URL normalization
The system MUST normalize base URL input accepting `host:port`, a trailing
`/v1`, or a trailing `/v1/`.

#### Scenario: Equivalent inputs normalize to one Provider
- GIVEN inputs `host:port`, `host:port/v1`, `host:port/v1/`, WHEN each is used
  with `add`, THEN all resolve to the same normalized base URL.

### Requirement: Reachability probe, 1-second timeout, no port scan
The system MUST probe `/v1/models` on each known base URL (existing Providers
plus Servers saved in plugin state) with timeout ≤ 1 s, and MUST NOT scan
ports.

#### Scenario: Empty response treated differently by operation
- GIVEN a Server that responds 200 with an empty model list:
  - For `add`: THEN it is rejected as a registration candidate (failure).
  - For `list`/`prune`: THEN it is shown as reachable, reporting 0 models (authoritative, not a failure).

#### Scenario: Unreachable Server reported with last error
- GIVEN a Server that does not respond within 1 s, WHEN probed, THEN it is
  shown as "not detected" with the last error.

### Requirement: Warn on omlx/mtplx-rewritten Provider keys
The system MUST warn immediately during `add` when the target Provider key is
one that `omlx launch pi` or `mtplx start pi` would rewrite.

#### Scenario: Warning shown at registration time
- GIVEN a Provider key matching the omlx/mtplx rewrite pattern, WHEN `add`
  registers it, THEN a warning is shown immediately, not deferred to a
  future Check.
