# Vercel Deployment

Create separate projects and do not share environment credentials.

| Project               | Root directory | Domain                  | Environment             |
| --------------------- | -------------- | ----------------------- | ----------------------- |
| Restec Sandbox API    | `apps/api`     | `sandbox-api.restec.io` | `RESTEC_ENV=sandbox`    |
| Restec Production API | `apps/api`     | `api.restec.io`         | `RESTEC_ENV=production` |
| Restec Docs           | `apps/docs`    | `docs.restec.io`        | public                  |
| Restec Portal/Demo    | `apps/portal`  | `portal.restec.io`      | protected               |

The API imports workspace packages above `apps/api`. Configure the build to include files outside the selected root, or set the repository root as the Vercel root and use the API project's build/output settings. Do not deploy a function bundle that omits `packages/*`.

API variables, without values: `RESTEC_ENV`, `RESTEC_REPOSITORY_DRIVER`, `RESTEC_PUBLIC_BASE_URL`, `RESTEC_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PAELY_PRIVATE_BASE_URL`, `PAELY_SERVICE_ID`, `PAELY_PRIVATE_BEARER_TOKEN`, `PAELY_PRIVATE_SIGNING_SECRET`, `PAELY_EVENT_SIGNING_SECRET`, `RESTEC_API_KEY_HASH_SECRET`, `RESTEC_SECRET_ENCRYPTION_KEY`, `RESTEC_WEBHOOK_MASTER_KEY`, `RESTEC_TIMESTAMP_TOLERANCE_SECONDS`, `RESTEC_PRIVATE_REQUEST_TIMEOUT_MS`, `RESTEC_POS_DELIVERY_TIMEOUT_MS`, `RESTEC_MAX_DELIVERY_ATTEMPTS`, `RESTEC_DISPATCH_BATCH_SIZE`, `RESTEC_INTERNAL_JOB_TOKEN`, `RESTEC_STRICT_RATE_LIMITING`, `RESTEC_SHARED_RATE_LIMITER_URL`, `RESTEC_SHARED_RATE_LIMITER_TOKEN`, and `CRON_SECRET`.

Set the scheduler to POST `/api/internal/jobs/dispatch-pos-events` with the protected bearer token at a cadence that meets the retry SLA. Deploy migrations before application traffic. Verify `/health`, create a sandbox credential, run mock E2E, and inspect delivery evidence. Production promotion additionally requires real sandbox certification, retry certification, security checks, monitoring, production secrets, and a controlled restaurant smoke test.
