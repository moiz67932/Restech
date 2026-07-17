import { generateApiKey, hashApiKey, encryptSecret } from '@restec/security';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
if (process.env.RESTEC_ENV === 'production')
  throw new Error('This command is forbidden in production.');
const hashSecret = process.env.RESTEC_API_KEY_HASH_SECRET;
const encryptionKey = process.env.RESTEC_SECRET_ENCRYPTION_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!hashSecret || hashSecret.length < 32 || !encryptionKey)
  throw new Error(
    'Set development RESTEC_API_KEY_HASH_SECRET and RESTEC_SECRET_ENCRYPTION_KEY first.',
  );
if (!supabaseUrl || !serviceKey) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
const generated = generateApiKey('sandbox');
const signingSecret = randomBytes(32).toString('base64url');
const webhookSecret = randomBytes(32).toString('base64url');
const connector = encryptSecret(
  JSON.stringify({
    webhook_url: 'https://example.invalid/restec-webhook',
    webhook_secret: webhookSecret,
  }),
  encryptionKey,
);
const signingEncrypted = encryptSecret(signingSecret, encryptionKey);
const webhookEncrypted = encryptSecret(webhookSecret, encryptionKey);
console.log('NON-PRODUCTION CREDENTIALS — DISPLAYED ONCE');
console.log(`API key: ${generated.key}`);
console.log(`Partner request-signing secret: ${signingSecret}`);
console.log(`POS webhook secret: ${webhookSecret}`);
const stored = {
  partner_id: 'ptr_sandbox_demo',
  environment: 'sandbox',
  key_prefix: generated.prefix,
  key_hash: hashApiKey(generated.key, hashSecret),
  encrypted_signing_secret: signingEncrypted,
  encrypted_connector_configuration: connector,
  encrypted_webhook_secret: webhookEncrypted,
};
const db = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { error: keyError } = await db.from('api_keys').insert({
  partner_id: stored.partner_id,
  environment: stored.environment,
  key_prefix: stored.key_prefix,
  key_hash: stored.key_hash,
  status: 'active',
  encrypted_signing_secret: stored.encrypted_signing_secret,
});
if (keyError) throw new Error('Failed to store sandbox API key.');
const { error: connectionError } = await db
  .from('pos_connections')
  .update({ encrypted_configuration: stored.encrypted_connector_configuration })
  .in('id', ['con_sandbox_canonical', 'con_sandbox_mock']);
if (connectionError) throw new Error('Failed to store connector configuration.');
const { error: webhookError } = await db
  .from('webhook_endpoints')
  .update({ encrypted_signing_secret: stored.encrypted_webhook_secret })
  .eq('connection_id', 'con_sandbox_canonical');
if (webhookError) throw new Error('Failed to store webhook secret.');
console.log(
  'Only hashes/encrypted values were stored. Save the displayed secrets now; they cannot be recovered from this command.',
);
