# Review Ledger — v0.1-registrar

## PR1 bootstrap (`pr1-bootstrap` vs `main`) — R3 reliability, 2026-08-30

Sweep: 1 (standard tier). Verified in a disposable worktree (`npm ci` + `npm test`, exit 0). No BLOCKER/CRITICAL findings; no refutation pass required. Editor diagnostic TS2307 on `vitest.config.ts` REFUTED: `npx tsc --noEmit` exits 0 both as-configured and with the file force-included; LSP artifact.

| id | lens | location | severity | status | evidence |
|---|---|---|---|---|---|
| R3-001 | reliability | tsconfig.json:16 (`include`) | SUGGESTION | info | `include: ["extensions","tests"]` never covers root config files (confirmed via `tsc --listFiles`), so a future `typecheck` CI gate would silently skip `vitest.config.ts`. Harmless today; include root configs when a typecheck script lands. |
