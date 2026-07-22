# Sandbox Setup

Apply migrations and seed with `npm run db:reset`. For a linked remote sandbox, use `npx supabase db push --dry-run` and then `npx supabase db push --include-seed`. Set non-production hash/encryption secrets and server Supabase variables, then run `npm run create:sandbox-credentials`; it verifies the project access, schema and fixtures before generation, stores all credential material atomically, verifies the stored hash and encrypted secrets, and only then prints complete credentials once. Start with `RESTEC_ENV=sandbox` and `RESTEC_REPOSITORY_DRIVER=supabase`.

The credential command loads the root `.env` file when it exists. Create it from `.env.example`, then replace the Supabase placeholders and generate separate development secrets. In PowerShell:

```powershell
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Use the first generated value for `RESTEC_API_KEY_HASH_SECRET` and the second for `RESTEC_SECRET_ENCRYPTION_KEY`. Also set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the sandbox project. Never commit `.env` or use production credentials with this command.

Fixtures include one partner, restaurant and location; canonical and mock connections; five tables/mappings; and active/disabled webhook endpoints. No real secret is committed.
