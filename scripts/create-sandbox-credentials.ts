import {
  decryptSecret,
  encryptSecret,
  generateApiKey,
  hashApiKey,
  secureEqual,
} from '@restec/security';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const sandboxPartnerId = 'ptr_sandbox_demo';
const sandboxConnectionIds = ['con_sandbox_canonical', 'con_sandbox_mock'] as const;
const sandboxWebhookConnectionId = 'con_sandbox_canonical';

export interface SanitizedDatabaseError {
  message: string | null;
  code: string | null;
  details: string | null;
  hint: string | null;
}

export class SandboxCredentialDatabaseError extends Error {
  public readonly operation: string;
  public readonly databaseError: SanitizedDatabaseError;

  constructor(operation: string, databaseError: SanitizedDatabaseError) {
    super(`${operation} failed`);
    this.name = 'SandboxCredentialDatabaseError';
    this.operation = operation;
    this.databaseError = databaseError;
  }
}

const errorField = (error: unknown, field: keyof SanitizedDatabaseError) => {
  if (!error || typeof error !== 'object' || !(field in error)) return null;
  const value = error[field as keyof typeof error];
  return typeof value === 'string' ? value : value == null ? null : String(value);
};

export function sanitizeDatabaseError(
  error: unknown,
  sensitiveValues: readonly string[] = [],
): SanitizedDatabaseError {
  const redact = (value: string | null) => {
    if (value === null) return null;
    return sensitiveValues
      .filter((secret) => secret.length > 0)
      .reduce((sanitized, secret) => sanitized.replaceAll(secret, '[redacted]'), value);
  };
  return {
    message: redact(errorField(error, 'message')),
    code: redact(errorField(error, 'code')),
    details: redact(errorField(error, 'details')),
    hint: redact(errorField(error, 'hint')),
  };
}

const databaseFailure = (
  operation: string,
  error: unknown,
  sensitiveValues: readonly string[] = [],
): never => {
  throw new SandboxCredentialDatabaseError(
    operation,
    sanitizeDatabaseError(error, sensitiveValues),
  );
};

interface StoredCredentials {
  partner_id: string;
  environment: 'sandbox';
  key_prefix: string;
  key_hash: string;
  encrypted_signing_secret: string;
  encrypted_connector_configuration: string;
  encrypted_webhook_secret: string;
}

interface StoredCredentialRows {
  apiKey: { key_hash: string; encrypted_signing_secret: string } | null;
  connections: Array<{ id: string; encrypted_configuration: string }>;
  webhook: { encrypted_signing_secret: string } | null;
}

export function assertStoredCredentials(
  rows: StoredCredentialRows,
  expected: StoredCredentials,
): void {
  if (
    !rows.apiKey ||
    !secureEqual(rows.apiKey.key_hash, expected.key_hash) ||
    !secureEqual(rows.apiKey.encrypted_signing_secret, expected.encrypted_signing_secret)
  )
    throw new Error('Sandbox API key hash or request-signing secret verification failed.');

  if (
    rows.connections.length !== sandboxConnectionIds.length ||
    !sandboxConnectionIds.every((id) =>
      rows.connections.some(
        (connection) =>
          connection.id === id &&
          secureEqual(
            connection.encrypted_configuration,
            expected.encrypted_connector_configuration,
          ),
      ),
    )
  )
    throw new Error('Sandbox connector configuration verification failed.');

  if (
    !rows.webhook ||
    !secureEqual(rows.webhook.encrypted_signing_secret, expected.encrypted_webhook_secret)
  )
    throw new Error('Sandbox webhook secret verification failed.');
}

async function assertServiceRoleMatchesProject(db: SupabaseClient): Promise<void> {
  const { error } = await db.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error) databaseFailure('Supabase project/service-role verification', error);
}

async function assertSandboxSchemaAndSeed(db: SupabaseClient): Promise<void> {
  const { error: schemaError } = await db
    .from('api_keys')
    .select('id,partner_id,environment,key_prefix,key_hash,status,encrypted_signing_secret')
    .limit(0);
  if (schemaError) databaseFailure('Restec credential schema verification', schemaError);

  const [partner, connections, webhook] = await Promise.all([
    db.from('partners').select('id').eq('id', sandboxPartnerId),
    db
      .from('pos_connections')
      .select('id,partner_id,environment,encrypted_configuration')
      .in('id', [...sandboxConnectionIds]),
    db
      .from('webhook_endpoints')
      .select('id,connection_id,encrypted_signing_secret,status')
      .eq('connection_id', sandboxWebhookConnectionId)
      .eq('status', 'active'),
  ]);
  if (partner.error) databaseFailure('Sandbox partner seed verification', partner.error);
  if (connections.error) databaseFailure('Sandbox connector seed verification', connections.error);
  if (webhook.error) databaseFailure('Sandbox webhook seed verification', webhook.error);

  if (partner.data.length !== 1)
    throw new Error(`Sandbox seed is missing partner ${sandboxPartnerId}.`);
  if (
    connections.data.length !== sandboxConnectionIds.length ||
    !sandboxConnectionIds.every((id) =>
      connections.data.some(
        (connection) =>
          connection.id === id &&
          connection.partner_id === sandboxPartnerId &&
          connection.environment === 'sandbox',
      ),
    )
  )
    throw new Error('Sandbox seed is missing one or more required POS connections.');
  if (webhook.data.length !== 1)
    throw new Error('Sandbox seed must contain exactly one active canonical webhook endpoint.');
}

async function storeCredentialsAtomically(
  db: SupabaseClient,
  stored: StoredCredentials,
  sensitiveValues: readonly string[],
): Promise<void> {
  const { data, error } = await db.rpc('store_sandbox_credentials', {
    p_partner_id: stored.partner_id,
    p_key_prefix: stored.key_prefix,
    p_key_hash: stored.key_hash,
    p_encrypted_request_signing_secret: stored.encrypted_signing_secret,
    p_encrypted_connector_configuration: stored.encrypted_connector_configuration,
    p_encrypted_webhook_secret: stored.encrypted_webhook_secret,
  });
  if (error) databaseFailure('Atomic sandbox credential storage', error, sensitiveValues);

  const result = data?.[0];
  if (
    !result?.api_key_hash_stored ||
    !result?.request_signing_secret_stored ||
    result?.connector_configuration_count !== sandboxConnectionIds.length ||
    result?.webhook_secret_count !== 1 ||
    !result?.webhook_secret_stored
  )
    throw new Error('Atomic sandbox credential storage returned an incomplete result.');
}

async function verifyStoredCredentials(
  db: SupabaseClient,
  stored: StoredCredentials,
  sensitiveValues: readonly string[],
): Promise<void> {
  const [apiKey, connections, webhook] = await Promise.all([
    db
      .from('api_keys')
      .select('key_hash,encrypted_signing_secret')
      .eq('partner_id', stored.partner_id)
      .eq('environment', stored.environment)
      .eq('key_prefix', stored.key_prefix)
      .single(),
    db
      .from('pos_connections')
      .select('id,encrypted_configuration')
      .in('id', [...sandboxConnectionIds]),
    db
      .from('webhook_endpoints')
      .select('encrypted_signing_secret')
      .eq('connection_id', sandboxWebhookConnectionId)
      .eq('status', 'active')
      .single(),
  ]);
  if (apiKey.error)
    databaseFailure('Stored sandbox API key verification', apiKey.error, sensitiveValues);
  if (connections.error)
    databaseFailure(
      'Stored connector configuration verification',
      connections.error,
      sensitiveValues,
    );
  if (webhook.error)
    databaseFailure('Stored webhook secret verification', webhook.error, sensitiveValues);

  assertStoredCredentials(
    {
      apiKey: apiKey.data,
      connections: connections.data,
      webhook: webhook.data,
    },
    stored,
  );
}

const requiredEnvironment = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before creating sandbox credentials.`);
  return value;
};

export async function createSandboxCredentials(): Promise<void> {
  if (process.env.RESTEC_ENV !== 'sandbox')
    throw new Error('RESTEC_ENV=sandbox is required; production credential creation is forbidden.');

  const hashSecret = requiredEnvironment('RESTEC_API_KEY_HASH_SECRET');
  const encryptionKey = requiredEnvironment('RESTEC_SECRET_ENCRYPTION_KEY');
  const supabaseUrl = requiredEnvironment('SUPABASE_URL');
  const serviceKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
  if (hashSecret.length < 32)
    throw new Error('RESTEC_API_KEY_HASH_SECRET must be at least 32 characters.');
  if (Buffer.from(encryptionKey, 'base64').length !== 32)
    throw new Error('RESTEC_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');

  const projectUrl = new URL(supabaseUrl);
  if (!/^[a-z0-9]+\.supabase\.co$/.test(projectUrl.hostname))
    throw new Error('SUPABASE_URL must identify a hosted Supabase project.');

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await assertServiceRoleMatchesProject(db);
  await assertSandboxSchemaAndSeed(db);

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
  const stored: StoredCredentials = {
    partner_id: sandboxPartnerId,
    environment: 'sandbox',
    key_prefix: generated.prefix,
    key_hash: hashApiKey(generated.key, hashSecret),
    encrypted_signing_secret: signingEncrypted,
    encrypted_connector_configuration: connector,
    encrypted_webhook_secret: webhookEncrypted,
  };
  const sensitiveValues = [
    generated.key,
    generated.prefix,
    signingSecret,
    webhookSecret,
    signingEncrypted,
    webhookEncrypted,
    connector,
  ];

  await storeCredentialsAtomically(db, stored, sensitiveValues);
  await verifyStoredCredentials(db, stored, sensitiveValues);

  if (decryptSecret(signingEncrypted, encryptionKey) !== signingSecret)
    throw new Error('Request-signing secret encryption verification failed.');
  if (decryptSecret(webhookEncrypted, encryptionKey) !== webhookSecret)
    throw new Error('Webhook secret encryption verification failed.');

  console.log('NON-PRODUCTION CREDENTIALS - DISPLAYED ONCE');
  console.log(`API key: ${generated.key}`);
  console.log(`Partner request-signing secret: ${signingSecret}`);
  console.log(`POS webhook secret: ${webhookSecret}`);
  console.log('Atomic storage and read-back verification succeeded for all three credentials.');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
  createSandboxCredentials().catch((error: unknown) => {
    if (error instanceof SandboxCredentialDatabaseError) {
      console.error(
        JSON.stringify(
          {
            error: 'Sandbox credential database operation failed.',
            operation: error.operation,
            database: error.databaseError,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(
        `Sandbox credential creation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exitCode = 1;
  });
