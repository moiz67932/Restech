import { createClient } from '@supabase/supabase-js';
import { decryptSecret, encryptSecret } from '@restec/security';
import { SupabaseRepository } from '@restec/database';

if (process.env.RUN_REMOTE_SANDBOX_TESTS !== 'true')
  throw new Error('Refusing remote writes. Set RUN_REMOTE_SANDBOX_TESTS=true explicitly.');
if (process.env.RESTEC_ENV !== 'sandbox')
  throw new Error('The dummy POS destination can be configured only in sandbox.');
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};
const databaseUrl = required('SUPABASE_URL');
const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
const encryptionKey = required('RESTEC_SECRET_ENCRYPTION_KEY');
const apiKeyHashSecret = required('RESTEC_API_KEY_HASH_SECRET');
const destination = new URL(
  process.env.RESTEC_SANDBOX_MOCK_POS_URL ??
    'https://restech-api-qkrx.vercel.app/api/test/mock-pos-webhook',
);
if (
  destination.protocol !== 'https:' ||
  destination.pathname !== '/api/test/mock-pos-webhook' ||
  destination.username ||
  destination.password
)
  throw new Error('RESTEC_SANDBOX_MOCK_POS_URL is not an approved HTTPS receiver URL.');

const db = createClient(databaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data, error } = await db
  .from('pos_connections')
  .select('encrypted_configuration')
  .eq('id', 'con_sandbox_canonical')
  .eq('environment', 'sandbox')
  .eq('status', 'active')
  .single();
if (error || !data) throw new Error('The canonical sandbox connection was not found.');
let current: Record<string, unknown>;
try {
  current = JSON.parse(decryptSecret(data.encrypted_configuration, encryptionKey));
} catch {
  throw new Error('The existing encrypted connector configuration could not be read.');
}
if (typeof current.webhook_secret !== 'string' || !current.webhook_secret)
  throw new Error('The canonical sandbox connection has no configured webhook signing secret.');
const encrypted = encryptSecret(
  JSON.stringify({ ...current, webhook_url: destination.toString() }),
  encryptionKey,
);
const { error: updateError } = await db
  .from('pos_connections')
  .update({ encrypted_configuration: encrypted, updated_at: new Date().toISOString() })
  .eq('id', 'con_sandbox_canonical')
  .eq('environment', 'sandbox')
  .eq('status', 'active');
if (updateError) throw new Error('The encrypted sandbox connector update failed.');

const repository = new SupabaseRepository(db, {
  apiKeyHashSecret,
  secretEncryptionKey: encryptionKey,
});
const connection = await repository.authorizeLocation(
  'loc_sandbox_demo',
  'ptr_sandbox_demo',
  'sandbox',
);
if (
  connection?.connectionId !== 'con_sandbox_canonical' ||
  connection.configuration.webhook_url !== destination.toString()
)
  throw new Error('Repository-path read-back verification failed.');
console.log('Sandbox dummy POS destination updated and verified through the repository path.');
