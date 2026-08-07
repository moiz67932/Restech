# Phase 7 reconciliation baseline

Baseline branch: `main`; baseline commit: `151e299` (`Fix docs Vercel build dependencies`).

The working tree already contained Phase 1–6 implementation changes; they were preserved. Before this phase, bill reconciliation was an in-process compare, `refresh_private_bill` performed no refresh, manual review wrote only an audit row, payment-session reconciliation could commit provider terminal evidence through the existing inbox/reservation path, and dead-letter replay retained the existing event identity.

Required database/provider/real-POS executions remain gated by the repository’s existing environment guards. `npm run typecheck`, `npm test`, `npm run test:e2e:mock`, and `npm run check:migrations` are the local verification targets for this phase.
