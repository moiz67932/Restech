# Remote Supabase Sandbox Setup

This workflow is server-side and sandbox-only. Do not place the service-role key in a browser, client bundle, or POS configuration.

1. Create a dedicated non-production project and store its project reference as `RESTEC_SANDBOX_PROJECT_REF` in the operator's secret manager.
2. Authenticate and link deliberately:

   ```sh
   npx supabase login
   npx supabase link --project-ref <RESTEC_SANDBOX_PROJECT_REF>
   npx supabase db push --dry-run
   npx supabase db push
   ```

3. Review the dry-run migration order and rollback notes before push.
4. Apply `supabase/seed.sql` only to the dedicated sandbox, then run `npm run create:sandbox-credentials` with sandbox environment variables.
5. Run remote tests only with `RUN_REMOTE_SANDBOX_TESTS=true`. Normal tests do not contact remote systems.

Never run `supabase db reset --linked` against production. Production is never seeded automatically. Keep migration evidence, project reference, operator identity, time, and command result in the deployment record.

The current repository supports remote-only validation; Docker is optional. Database integration tests also require explicit endpoint and service-role configuration. A skipped remote test is reported as skipped, not passed.
