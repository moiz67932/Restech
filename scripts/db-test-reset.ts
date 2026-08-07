import { spawnSync } from 'node:child_process';

const env = process.env;
const fail = (message: string): never => {
  console.error(`DATABASE_RESET_REFUSED: ${message}`);
  process.exit(2);
};
if (env.RESTEC_DATABASE_CERTIFICATION !== 'true') fail('RESTEC_DATABASE_CERTIFICATION=true is required.');
if (!['disposable-local', 'ci'].includes(env.RESTEC_DATABASE_TARGET ?? '')) fail('only disposable-local or ci may be reset.');
if (!['test', 'sandbox'].includes(env.RESTEC_ENV ?? '')) fail('RESTEC_ENV must be test or sandbox.');
if (env.RESTEC_ALLOW_DATABASE_RESET !== 'true') fail('RESTEC_ALLOW_DATABASE_RESET=true is required.');
if (env.RESTEC_DATABASE_URL) fail('RESTEC_DATABASE_URL is not accepted by the local reset command.');
if (env.SUPABASE_URL && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(env.SUPABASE_URL))
  fail('SUPABASE_URL must point to the local Supabase stack.');
const result = spawnSync('npx', ['supabase', 'db', 'reset'], { stdio: 'inherit', env, shell: true });
process.exit(result.status ?? 1);
