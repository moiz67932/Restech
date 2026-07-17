# Deployment

1. Create separate Supabase projects for sandbox and production; back up, run migration lint on a staging clone, apply migrations, then seed only sandbox.
2. Deploy the production API from `apps/api` as `restec-api-production` on `api.restec.io`, with `RESTEC_ENV=production` and production-only secrets.
3. Deploy the sandbox API from `apps/api` as `restec-api-sandbox` on `sandbox-api.restec.io`, with `RESTEC_ENV=sandbox` and sandbox-only secrets.
4. Deploy `apps/docs` as `restec-docs` on `docs.restec.io`, and `apps/portal` as `restec-portal` on `portal.restec.io`.
5. Invoke the protected dispatcher repeatedly from a scheduler. Database leases make overlapping invocations safe.
6. Run authentication, signature, migration, sandbox end-to-end, delivery failure, leakage, and smoke checks before enabling traffic.

Rollback by disabling new traffic, stopping scheduling, letting leases expire, preserving inbox/outbox/audit evidence, and rolling back application deployment. Database objects are additive; remove them only in reverse dependency order after retention approval.
