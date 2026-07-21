# Vercel Deployment

Create separate projects and do not share environment credentials.

| Project               | Root directory | Domain                  | Environment             |
| --------------------- | -------------- | ----------------------- | ----------------------- |
| Restec Sandbox API    | `apps/api`     | `sandbox-api.restec.io` | `RESTEC_ENV=sandbox`    |
| Restec Production API | `apps/api`     | `api.restec.io`         | `RESTEC_ENV=production` |
| Restec Docs           | `apps/docs`    | `docs.restec.io`        | public                  |
| Restec Portal/Demo    | `apps/portal`  | `portal.restec.io`      | protected               |

## API project build settings

Use these exact Vercel project settings for both Restec API projects:

| Setting          | Value           |
| ---------------- | --------------- |
| Framework Preset | `Other`         |
| Root Directory   | `apps/api`      |
| Build Command    | `npm run build` |
| Output Directory | Leave unset     |
| Node.js Version  | `24.x`          |

Enable **Include source files outside of the Root Directory in the Build Step**. Vercel discovers the repository-root `package-lock.json`, installs the npm workspaces, and runs the API workspace build. That build force-compiles the API and its TypeScript project references, then runs `verify:vercel-runtime`. The function entry imports `apps/api/dist/bootstrap.js`; internal package exports resolve only to `packages/**/dist/index.js`. `apps/api/vercel.json` includes those generated outputs and package manifests in the function bundle without including raw workspace source directories.

Do not override the build command with a command that skips `npm run build`, and do not deploy if runtime verification fails. The root and API package manifests pin Node `24.x`, matching the Vercel project setting.

API variables, without values: `RESTEC_ENV`, `RESTEC_REPOSITORY_DRIVER`, `RESTEC_PUBLIC_BASE_URL`, `RESTEC_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PAELY_PRIVATE_BASE_URL`, `PAELY_SERVICE_ID`, `PAELY_PRIVATE_BEARER_TOKEN`, `PAELY_PRIVATE_SIGNING_SECRET`, `PAELY_EVENT_SIGNING_SECRET`, `RESTEC_API_KEY_HASH_SECRET`, `RESTEC_SECRET_ENCRYPTION_KEY`, `RESTEC_WEBHOOK_MASTER_KEY`, `RESTEC_TIMESTAMP_TOLERANCE_SECONDS`, `RESTEC_PRIVATE_REQUEST_TIMEOUT_MS`, `RESTEC_POS_DELIVERY_TIMEOUT_MS`, `RESTEC_MAX_DELIVERY_ATTEMPTS`, `RESTEC_DISPATCH_BATCH_SIZE`, `RESTEC_INTERNAL_JOB_TOKEN`, `RESTEC_STRICT_RATE_LIMITING`, `RESTEC_SHARED_RATE_LIMITER_URL`, `RESTEC_SHARED_RATE_LIMITER_TOKEN`, and `CRON_SECRET`.

Set the scheduler to POST `/api/internal/jobs/dispatch-pos-events` with the protected bearer token at a cadence that meets the retry SLA. Deploy migrations before application traffic. Verify `/health`, create a sandbox credential, run mock E2E, and inspect delivery evidence. Production promotion additionally requires real sandbox certification, retry certification, security checks, monitoring, production secrets, and a controlled restaurant smoke test.

## Redeploying after a runtime build change

1. Run `npm ci`, `npm run build:api`, and `npm run verify:vercel-runtime` from the repository root.
2. Confirm the Vercel project settings above and that all existing environment variables remain assigned to the intended environment.
3. Push the reviewed commit and redeploy the existing sandbox API deployment without changing or rotating secrets.
4. Request `GET /health` and require HTTP `200` with `{"status":"ok","environment":"sandbox","version":"1.0.0"}` before running authenticated sandbox smoke tests.
5. Promote the same reviewed build to production only after the sandbox checks pass.
