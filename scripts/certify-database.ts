import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const fail = (message: string): never => {
  console.error(`DATABASE_CERTIFICATION_BLOCKED: ${message}`);
  process.exit(2);
};
const env = process.env;
const target = env.RESTEC_DATABASE_TARGET;
const forbidden = /(^|[-_.])(prod|production|live)([-_.]|$)/i;
if (env.RESTEC_DATABASE_CERTIFICATION !== 'true') fail('RESTEC_DATABASE_CERTIFICATION=true is required.');
if (!['test', 'sandbox'].includes(env.RESTEC_ENV ?? '')) fail('RESTEC_ENV must be test or sandbox.');
if (!['disposable-local', 'disposable-staging', 'ci'].includes(target ?? ''))
  fail('RESTEC_DATABASE_TARGET must be disposable-local, disposable-staging, or ci.');
if (forbidden.test(target ?? '') || forbidden.test(env.SUPABASE_URL ?? ''))
  fail('database identity resembles production.');
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
  fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
if (env.RUN_DATABASE_INTEGRATION !== 'true') fail('RUN_DATABASE_INTEGRATION=true is required.');

const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const probe = await db.rpc('release_expired_pos_outbox_leases');
if (probe.error) fail(`database probe failed (${probe.error.code ?? 'unknown'}).`);
const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', ...args], { stdio: 'inherit', env });
let result = run(['scripts/check-migrations.ts']);
if (result.status !== 0) process.exit(result.status ?? 1);
result = run(['--test', 'packages/database/src/supabase-repository.integration.test.ts', 'packages/database/src/supabase-repository.certification.test.ts']);
if (result.status !== 0) process.exit(result.status ?? 1);
result = run(['scripts/audit-financial-database-consistency.ts']);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('RESTEC_DATABASE_CERTIFICATION_PASS');
