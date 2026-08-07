# Phase 6 security and credential baseline

Date: 2026-08-07  
Branch: `main`  
Baseline commit: `151e2994090b6e42847387b467874b4c6f365ea5`

The worktree was already dirty before Phase 6. Existing changes were preserved and are not attributed to this phase.

## Baseline checks

- `npm run typecheck`: passed
- `npm test`: passed, 119 passed and 5 intentionally skipped
- `npm run check:migrations`: passed, 13 migrations before Phase 6
- `git diff --check`: passed (line-ending warnings only)
- Real PostgreSQL certification: gated; no destructive credential test was run

## Baseline architecture

- API authentication reads `api_keys`, verifies the key hash, decrypts the request-signing secret, checks environment, expiry, grace, scopes, location, timestamp, replay, and records last use.
- Webhook configuration existed in both `webhook_endpoints.encrypted_signing_secret` and `pos_connections.encrypted_configuration.webhook_secret`.
- Outbox delivery read the connector configuration and signed each attempt from that configuration.
- Webhook destinations already rejected credentials in URLs and private/link-local/metadata DNS answers.
- Production rate limiting already fails closed unless a shared adapter is configured.
- Production and sandbox repository/environment guards are enforced at config load and authentication.

## Phase 6 safety boundary

No existing `.env`, deployment variable, credential value, encrypted blob, key prefix, partner ID, location ID, connection ID, or deployed secret was changed by this phase. Plaintext secrets are absent from this report and test snapshots.
