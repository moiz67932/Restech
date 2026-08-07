# Phase 3 table QR baseline

- Branch: `main`
- Commit: `151e2994090b6e42847387b467874b4c6f365ea5`
- Working tree: already dirty with Phase 1/2 changes; preserved.
- Existing migrations before Phase 3: 10.
- Existing runtime: partner-authenticated table mapping lookup and bill upsert; payment browser route `/s/:paymentSessionId`; no permanent table token, current-bill resolver, table generation, or customer visit.
- Existing bill lifecycle: canonical bill status `open`, `completed`, or `cancelled`; version conflicts were enforced per bill.
- Baseline database certification: unavailable/gated; Phase 2 remains partial.
