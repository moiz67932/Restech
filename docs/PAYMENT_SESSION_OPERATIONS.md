# Payment Session Operations, Deployment, Certification, and Rollback

## Sandbox deployment

Do not deploy automatically. From the reviewed commit:

1. Back up the Restec sandbox database and test the additive migration on a disposable/current-schema clone.
2. Apply `supabase/migrations/20260723000100_payment_sessions.sql` and then `supabase/migrations/20260727000100_payment_session_checkout_refresh.sql` to the sandbox project using the team's normal `supabase db push --linked` or reviewed SQL migration process. Confirm the linked project is sandbox before approval.
3. Set `RESTEC_PAYMENT_SESSIONS_ENABLED=true`, TTL, Restec checkout base URL, explicit event service identity, and the security-reviewed exact sandbox checkout hostname. Keep all existing API-key, signing, encryption, database, and job secrets unchanged.
4. Confirm Paely's signed private checkout-refresh endpoint and its database migration are deployed.
   Apply Restec's checkout-refresh lease migration before deploying the exact tested Restec commit
   to the existing sandbox API project. Do not deploy production.
5. Require `/health` HTTP 200 with environment `sandbox`.
6. Run `npm run configure:sandbox-mock-pos` with the explicit remote-sandbox guard. It updates only encrypted `con_sandbox_canonical` configuration and verifies read-back through `SupabaseRepository`.
7. Confirm production remains `RESTEC_PAYMENT_SESSIONS_ENABLED=false`.
8. Run `npm run certify:real-payment-session`. Manually enter the sandbox test card on the hosted page. Never automate card entry.

Vercel remains: root directory `apps/api`, framework `Other`, build `npm run build`, output `public`, Node 24.x, outside-root workspace files enabled. `npx vercel build` is a local verification option when the project is safely linked; never run `vercel deploy` as part of this procedure.

## Certification pass criteria

The script passes only when health is sandbox, a fresh bill is created, the initial state is `requires_customer_action`, an authoritative event changes it to `paid`, the bill projection is paid, an inbox row exists, one POS outbox event is delivered, the signed dummy receiver durably accepts it, and it is not dead-lettered. `--verify` plus `RESTEC_CERTIFICATION_PAYMENT_SESSION_ID` and the preserved `RESTEC_CERTIFICATION_INITIAL_STATUS=requires_customer_action` evidence supports post-checkout non-interactive verification.

Opening the Restec checkout URL performs a signed Paely refresh immediately before redirect.
Restec sends exactly `{}`, validates the strict refreshed contract and exact checkout host, replaces
the encrypted stored URL under a per-session database lease, and only then returns HTTP 303. A
refresh failure never falls back to the old checkout capability. No new Restec environment variable
is required; existing Paely credentials, request timeout, encryption key, and checkout-host
allowlist are reused.

If the deployed private create route is absent, returns no real sandbox hosted URL, or emits no authoritative provider-backed event, record certification as blocked. Do not substitute public customer routes, mock success, direct provider calls, or browser automation.

## Reconciliation

Operational review must query sessions in `creating`, active sessions past `expires_at`, unmatched `review_required` inbox rows, local/private status mismatches when the private GET exists, paid bills without a session, and dead-lettered/exhausted POS deliveries. Reconciliation uses the private payment-session GET and never polls the regulated provider directly. Every action is idempotent.

## Production isolation

Keep `RESTEC_PAYMENT_SESSIONS_ENABLED=false`. Do not configure sandbox checkout hosts or secrets in production. With the flag false, create/status/browser routes return 404 before any new session state or private create call. Sandbox dummy and evidence endpoints return 404 outside sandbox. Existing bill, external-payment, table, event, reconciliation, and webhook behavior stays available.

## Rollback

1. Set `RESTEC_PAYMENT_SESSIONS_ENABLED=false` and redeploy the last reviewed build.
2. Confirm new create/status/browser routes return 404 and existing bill/table/webhook health checks pass.
3. Preserve pending sessions, inbox/outbox events, mock receipts, delivery attempts, and audit rows.
4. Workers must not create or reconcile payment sessions while disabled; existing POS outbox delivery policy remains unchanged.
5. Revert application commits with `git revert <commit-sha>` and redeploy the resulting reviewed commit.
6. Do not drop or reverse the additive financial/audit tables. PostgreSQL enum/check/RPC changes and evidence rows have no safe destructive automatic rollback. Revoke unused RPC grants only after retention and in-flight review.
