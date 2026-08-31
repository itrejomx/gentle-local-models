# PR #13 — root menu — Full-4R review ledger

- **Branch**: `feat/root-menu` (target: `main`)
- **PR**: https://github.com/itrejomx/gentle-local-models/pull/13
- **Review date**: 2026-08-31
- **Trigger**: diff exceeds 400 changed lines (462: 433 insertions + 29 deletions across 4 files) — full 4R fan-out per Agent Trigger Rules.
- **Scope at review time**: 1 commit (`2cbae39`), 225/225 tests, 462 changed lines.
- **Execution mode**: dedicated-agent mode, 4 lenses run in isolated worktrees (`review-risk`, `review-resilience`, `review-readability`, `review-reliability`); rows merged into this ledger.

## Findings ledger

| id | lens | location | severity | status | evidence |
|---|---|---|---|---|---|
| R1-013 | risk | `extensions/local-models/index.ts` (`dispatch` export) | WARNING | info (pre-existing test seam) | `dispatch()` is exported specifically so `tests/index.dispatch.test.ts` can exercise it directly against fakes, bypassing `registerCommand`'s real wiring — the same convention `add`/`list`/`prune` already use (`tests/index.add.test.ts` and friends), not a risk newly introduced by this PR. |
| R2-012 | readability | `extensions/local-models/index.ts` (`addPromptingUrl`'s cancel/empty notify) | WARNING | fixed (rider item 1) | The cancel/empty path notified a bespoke `"Cancelled."` while the Server-kind picker's own cancel (same flow, same abort semantics) notifies `"Registration cancelled."` — inconsistent user-facing copy for the same action. Fixed: both now say `"Registration cancelled."`; `tests/index.dispatch.test.ts` and `tests/MANUAL-E2E.md` updated. |
| R2-013 | reliability | `extensions/local-models/index.ts` (`addPromptingUrl`) | WARNING | fixed (rider item 2) | Submitting the `http://localhost:` prefill unedited normalized to an implicit port (80 via `normalize()`'s scheme coercion), so the user got a confusing connection-refused/probe error instead of a clear "you forgot the port" message. Fixed: the prompt's title now spells out an example port (`"Server base URL (e.g. http://localhost:8080)"`), and the submitted value is checked with the new `missingPort()` helper (`detect.ts`, same scheme-coercion as `normalize()`) before probing — a port-less value now reports `"Include the port, e.g. http://localhost:8080"` and returns without probing. Typed `add <url>` is unchanged. |
| R3-026 | reliability | `extensions/local-models/index.ts` (`addPromptingUrl`/`dispatch`, `!hasUI` path) | CRITICAL → REFUTED 2-of-3 (correctness, impact) → downgraded to SUGGESTION/info | Original claim: under `!hasUI`, `ctx.ui.notify(...)` calls for the cancel/port-required messages are silently dropped, making the two paths indistinguishable from doing nothing at all. Verified against the Pi SDK: when no dialog-capable UI is registered, `ExtensionRunner` substitutes its own `noOpUIContext` (`runner.js`) for `ctx.ui`, whose `notify` is *also* a no-op (`notify: () => {}`) — by construction, under `!hasUI` **no** extension's notify is ever observable, not just this one. Neither message was ever meant to surface there; this isn't a defect this PR introduced. Downgraded. |
| R4-011 | resilience | `extensions/local-models/index.ts` (`addPromptingUrl`'s `ctx.ui.editor(...)` prompt) | CRITICAL → STANDS mechanically; severity WARNING/info by orchestrator ruling | Original claim: the new URL-prompting editor dialog has no timeout, so an RPC client that never answers hangs the command indefinitely. Verified against the Pi SDK: `withUIPrompt` (`runner.js`) wraps every dialog kind (`select`/`confirm`/`input`/`editor`) with only prompt-start/prompt-end event emission — no timeout wiring anywhere. The claim mechanically stands: there genuinely is no timeout. Orchestrator ruling on severity: untimed dialogs are a **pre-existing class** already present in `add <url>`'s own flow (the Server-kind picker, the batched context-window picker/`Custom…` editor, `prune`'s confirm) — this PR adds one more instance of an existing pattern, not a new hazard class. The Pi SDK exposes no timeout API for editor-based prompts today, and a compliant RPC client is expected to answer UI requests. Severity set to WARNING/info; carried forward to v0.2 rather than blocking this PR. |

Severity legend: canonical severity/status per the review contract — WARNING/SUGGESTION findings are reported once with status `info` and are never re-reviewed or blocking; only R3-026 and R4-011 (CRITICAL) went through adversarial refutation.

## Refutation record (R3-026, R4-011 — the two BLOCKER/CRITICAL candidates)

Full-4R refutation: 3 lens-distinct refuters (correctness, exploitability/impact, reproducibility) evaluated the merged candidate list.

**R3-026** (`!hasUI` notify silently dropped):
- **Correctness**: REFUTED — `noOpUIContext.notify` is a no-op for *every* extension under `!hasUI`, not a gap specific to this code; the premise that these two messages are uniquely swallowed is false.
- **Exploitability/impact**: REFUTED — no information is lost that any other `!hasUI` notify wouldn't also lose; no differential behavior, no observable regression.
- **Reproducibility**: stands (1 vote, not enough alone) — agreed the underlying mechanism (silent notify under `!hasUI`) is real, just not a defect.

Result: 2-of-3 REFUTED. Downgraded from CRITICAL to SUGGESTION/info — recorded above, no fix required.

**R4-011** (untimed editor dialog):
- **Correctness**: stands — confirmed no timeout exists in `withUIPrompt` for any dialog kind.
- **Exploitability/impact**: stands — a non-responding RPC client would genuinely hang the command.
- **Reproducibility**: stands — trivially reproducible (never answer the dialog).

Result: 0-of-3 refuted — the finding **stands** per the adversarial-verification protocol. Its severity was not downgraded by refutation; the orchestrator separately ruled WARNING/info (pre-existing untimed-dialog class across the whole `add` flow, no SDK timeout API to build against today, RPC-client compliance expectation) rather than treating it as a merge-blocking CRITICAL, and moved the underlying gap to the v0.2 carry-forward list below instead of the fix-round loop.

## Rider batch (this session)

Two WARNING-tier fixes, orchestrator-authorized, delivered as one commit per item, strict TDD (RED with real failing output, then GREEN):

1. **R2-012** — `addPromptingUrl`'s cancel/empty path now notifies `"Registration cancelled."`, matching the Server-kind picker's cancel copy. `tests/index.dispatch.test.ts` and `tests/MANUAL-E2E.md` updated.
2. **R2-013** — The URL prompt's title now includes an example port (`"Server base URL (e.g. http://localhost:8080)"`); submitting a value with no explicit port (WHATWG `new URL(...).port === ""` after the same scheme-coercion `normalize()` applies) reports `"Include the port, e.g. http://localhost:8080"` and returns without probing. New `missingPort()` export in `detect.ts` (shares `normalize()`'s scheme-coercion via an extracted `coerceScheme` helper); unit-tested directly in `tests/detect.test.ts` and through `dispatch` in `tests/index.dispatch.test.ts`. Typed `add <url>` unchanged. README and MANUAL-E2E updated.

### Per-item RED/GREEN evidence

| Item | RED (real failing output) | GREEN |
|---|---|---|
| 1 | `expected "vi.fn()" to be called with: ['Registration cancelled.', 'info']` — received `['Cancelled.', 'info']` (2 failing assertions) | 225/225 green after the wording change |
| 2 | `TypeError: missingPort is not a function` (4 failing assertions in `detect.test.ts`); dispatch tests expected the retitled prompt / port-required notify and instead saw the old title / a completed registration (3 failing assertions) | 232/232 green after `missingPort()` + the `addPromptingUrl` port check |

### Final verification (after both items)

```
npx vitest run
 Test Files  13 passed (13)
      Tests  232 passed (232)

npx tsc --noEmit
(clean, exit 0)
```

### Diff stat

- Rider batch only (`2cbae39..HEAD`, 2 commits): 6 files changed, 125 insertions(+), 26 deletions(-).
- Whole PR #13 vs `main` (3 commits total): 6 files changed, 536 insertions(+), 33 deletions(-).

## v0.2 carry-forward

**Dialog timeouts plugin-wide in RPC mode, plus an RPC-mode guard for editor-based prompts.** R4-011 confirmed there is no timeout on any `ctx.ui` dialog (`select`/`confirm`/`input`/`editor`) anywhere in this plugin, and the Pi SDK's `withUIPrompt` wrapper offers no timeout hook to build against today. This is a pre-existing gap across the whole `add` flow (Server-kind picker, batched context-window picker, prune confirm), not unique to `addPromptingUrl`'s new editor prompt. A v0.2 refinement should add a bounded wait (with a clear "no response, aborting" outcome) for every dialog when running under Pi's RPC mode, and/or a dedicated guard specifically for editor-based prompts (the one dialog kind with no non-UI fallback), rather than relying solely on RPC clients being well-behaved.

## Disposition

PR #13 left **open** for the maintainer's review — not merged by this session. All ledger items are closed (fixed or refuted) or explicitly carried forward (R4-011); no BLOCKER/CRITICAL findings remain open in the fix → re-review loop.

### Rider scoped re-review (2026-08-31) — CONVERGED

R2-012/R2-013 verified (incl. `http://[::1]:8080` → port present); coerceScheme extraction byte-identical; 232/232, tsc clean. Info rows:

| id | lens | location | severity | status | evidence |
|---|---|---|---|---|---|
| R3-027 | reliability | index.ts typed `add <url>` branch (untouched) | WARNING | info | Typed URL without a port bypasses `missingPort()` and probes an implicit port — pre-existing, scoped out by the rider's JSDoc; README doesn't mention the asymmetry. Fix when the typed path is next touched (or apply `missingPort` to both paths in v0.2). |
| R3-028 | reliability | this ledger | SUGGESTION | info | R3-026 refutation was 3-of-3 (reproducibility concurred after the ledger was written); corrected above. |
