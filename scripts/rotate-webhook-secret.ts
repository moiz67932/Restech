import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';
import { encryptSecret } from '@restec/security';

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
const approved = () => {
  if (!process.argv.includes('--apply')) throw new Error('No changes made. Re-run with --apply.');
  if (arg('--environment') === 'production' && process.env.RESTEC_PROVISIONING_APPROVED !== 'YES')
    throw new Error('Production rotation requires RESTEC_PROVISIONING_APPROVED=YES.');
};

async function main() {
  approved();
  const connectionId = arg('--connection-id');
  const environment = arg('--environment');
  if (!connectionId || !/^con_/.test(connectionId)) throw new Error('--connection-id is required.');
  if (environment !== 'sandbox' && environment !== 'production')
    throw new Error('--environment must be sandbox or production.');
  const graceSeconds = Number(arg('--grace-seconds') ?? '86400');
  if (!Number.isInteger(graceSeconds) || graceSeconds < 0 || graceSeconds > 604800)
    throw new Error('--grace-seconds must be an integer from 0 to 604800.');
  const db = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: connection, error: connectionError } = await db
    .from('pos_connections')
    .select('id,partner_id,location_id,environment,status')
    .eq('id', connectionId)
    .eq('environment', environment)
    .maybeSingle();
  if (connectionError || !connection || connection.status !== 'active')
    throw new Error('Active webhook connection was not found for the requested environment.');
  const secret = randomBytes(32).toString('base64url');
  const { data: version, error } = await db.rpc('rotate_webhook_secret', {
    p_connection_id: connectionId,
    p_encrypted_secret: encryptSecret(secret, required('RESTEC_SECRET_ENCRYPTION_KEY')),
    p_grace_seconds: graceSeconds,
  });
  if (error || typeof version !== 'number') throw new Error('Webhook secret rotation failed.');
  // This is the sole plaintext display. It is intentionally not logged elsewhere.
  console.log(
    JSON.stringify(
      {
        warning: 'WEBHOOK SECRET DISPLAYED ONCE - STORE SECURELY',
        partner_id: connection.partner_id,
        location_id: connection.location_id,
        environment,
        connection_id: connection.id,
        version,
        grace_seconds: graceSeconds,
        webhook_signing_secret: secret,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
