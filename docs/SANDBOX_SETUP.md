# Sandbox Setup

Apply migrations and seed with `npm run db:reset`. Set non-production hash/encryption secrets and server Supabase variables, then run `npm run create:sandbox-credentials`; it stores only hashes/encrypted values and prints complete credentials once. Start with `RESTEC_ENV=sandbox` and `RESTEC_REPOSITORY_DRIVER=supabase`.

Fixtures include one partner, restaurant and location; canonical and mock connections; five tables/mappings; and active/disabled webhook endpoints. No real secret is committed.
