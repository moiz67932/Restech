# Phase 2 database test architecture

## Current state

`SupabaseRepository` uses `@supabase/supabase-js` and service-role RPC calls. Existing integration tests are gated by `RUN_DATABASE_INTEGRATION` or `RUN_REMOTE_SANDBOX_TESTS` plus `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. They currently cover one inbox/outbox path and additive payment-session transitions. The Phase 1 RPCs use PostgreSQL row locks, and the outbox claim function uses `FOR UPDATE SKIP LOCKED`.

## Required state

Certification requires a disposable local or dedicated non-production database, all migrations from zero, an upgrade rehearsal, two independent client connections, real RPC execution, 100-request races, worker lease tests, rollback/recovery evidence, and a read-only consistency audit. Missing credentials must be an error, never a skip.

## Available execution options

1. Local Supabase: install/start Docker, run `npm run db:test:reset`, then run the certification command.
2. Disposable staging Supabase: provide service-role credentials, an explicit non-production identity marker, and pre-created synthetic fixtures.
3. CI: use the repository's Supabase CLI job and disposable local stack.

## Missing tools and credentials

This workstation has the Supabase CLI package but no running Docker daemon, no `SUPABASE_URL`, no `SUPABASE_SERVICE_ROLE_KEY`, and no configured certification fixture connection.

## Safe recommended approach

Use local Supabase in CI or a disposable local stack first. Set `RESTEC_DATABASE_CERTIFICATION=true`, `RESTEC_DATABASE_TARGET=disposable-local` or `ci`, `RESTEC_ENV=test`, `RUN_DATABASE_INTEGRATION=true`, and `RESTEC_CERTIFICATION_CONNECTION_ID=con_sandbox_canonical`. Never place secrets in this document or logs.
