import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { encryptSecret, generateApiKey, hashApiKey } from '@restec/security';

type Environment = 'sandbox' | 'production';
type ProvisioningInput = {
  partner_id?: string;
  partner_name: string;
  restaurant_id?: string;
  restaurant_name: string;
  location_id?: string;
  location_name: string;
  external_location_id: string;
  connection_id?: string;
  callback_url: string;
  scopes?: string[];
  location_scopes?: string[];
  expires_at: string;
  technical_contacts?: Array<{ name: string; email: string; role?: string }>;
  allowed_ip_requirements?: string[];
  mtls?: { subjects?: string[]; certificate_fingerprints?: string[] };
  inbound_auth?: { type: 'none' | 'bearer' | 'api_key'; identifier?: string };
  key_prefix?: string;
};

const defaultScopes = [
  'bills:read',
  'bills:write',
  'payments:write',
  'payment_sessions:read',
  'payment_sessions:write',
  'tables:read',
];
const allowedScopes = new Set(defaultScopes);

const validCidr = (value: string) => {
  const [address, prefix, extra] = value.split('/');
  const family = isIP(address ?? '');
  if (!family || extra !== undefined) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  return family === 4 ? bits >= 0 && bits <= 32 : bits >= 0 && bits <= 128;
};

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const publicId = (prefix: string) => `${prefix}_${randomBytes(10).toString('hex')}`;

export function validateProvisioningInput(value: unknown): ProvisioningInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The provisioning input must be a JSON object.');
  const input = value as Record<string, unknown>;
  for (const field of [
    'partner_name',
    'restaurant_name',
    'location_name',
    'external_location_id',
    'callback_url',
    'expires_at',
  ])
    if (typeof input[field] !== 'string' || !input[field]) throw new Error(`${field} is required.`);
  const callback = new URL(String(input.callback_url));
  if (callback.protocol !== 'https:') throw new Error('callback_url must use HTTPS.');
  const expiresAt = new Date(String(input.expires_at)).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
    throw new Error('expires_at must be a future ISO date-time.');
  for (const field of ['scopes', 'location_scopes', 'allowed_ip_requirements'])
    if (input[field] !== undefined && !Array.isArray(input[field]))
      throw new Error(`${field} must be an array.`);
  const scopes = Array.isArray(input.scopes) ? input.scopes : defaultScopes;
  if (
    !scopes.length ||
    scopes.some((scope) => typeof scope !== 'string' || !allowedScopes.has(scope))
  )
    throw new Error('scopes contains an unsupported operation scope.');
  if (
    Array.isArray(input.allowed_ip_requirements) &&
    input.allowed_ip_requirements.some((entry) => typeof entry !== 'string' || !validCidr(entry))
  )
    throw new Error('allowed_ip_requirements must contain valid IPv4 or IPv6 CIDRs.');
  return input as ProvisioningInput;
}

async function database() {
  const url = required('SUPABASE_URL');
  const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const response = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await response.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error) throw new Error('The database service credential could not be verified.');
  return response;
}

function generatedCredential(environment: Environment) {
  const api = generateApiKey(environment);
  return {
    api,
    requestSigningSecret: randomBytes(32).toString('base64url'),
    webhookSigningSecret: randomBytes(32).toString('base64url'),
  };
}

function assertOperatorApproval(environment: Environment) {
  if (!process.argv.includes('--apply'))
    throw new Error('No changes made. Re-run with --apply after reviewing the input.');
  if (environment === 'production' && process.env.RESTEC_PROVISIONING_APPROVED !== 'YES')
    throw new Error('Production issuance requires RESTEC_PROVISIONING_APPROVED=YES.');
}

async function provision(environment: Environment, input: ProvisioningInput) {
  assertOperatorApproval(environment);
  const hashSecret = required('RESTEC_API_KEY_HASH_SECRET');
  const encryptionKey = required('RESTEC_SECRET_ENCRYPTION_KEY');
  const managedLocationReference = required('RESTEC_MANAGED_LOCATION_REFERENCE');
  const managedConnectionReference = required('RESTEC_MANAGED_CONNECTION_REFERENCE');
  const inboundCredential = process.env.RESTEC_POS_INBOUND_CREDENTIAL;
  const generated = generatedCredential(environment);
  const partnerId = input.partner_id ?? publicId('ptr');
  const restaurantId = input.restaurant_id ?? publicId('rst');
  const locationId = input.location_id ?? publicId('loc');
  const connectionId = input.connection_id ?? publicId('con');
  const connectorConfiguration = encryptSecret(
    JSON.stringify({
      webhook_url: input.callback_url,
      webhook_secret: generated.webhookSigningSecret,
    }),
    encryptionKey,
  );
  const inboundAuthDetails = input.inbound_auth
    ? {
        ...input.inbound_auth,
        ...(inboundCredential
          ? { encrypted_credential: encryptSecret(inboundCredential, encryptionKey) }
          : {}),
      }
    : null;
  const db = await database();
  const { data, error } = await db.rpc('provision_pos_partner', {
    p_partner_id: partnerId,
    p_partner_name: input.partner_name,
    p_restaurant_id: restaurantId,
    p_restaurant_name: input.restaurant_name,
    p_location_id: locationId,
    p_location_name: input.location_name,
    p_external_location_id: input.external_location_id,
    p_environment: environment,
    p_connection_id: connectionId,
    p_private_location_reference: managedLocationReference,
    p_private_connection_reference: managedConnectionReference,
    p_key_prefix: generated.api.prefix,
    p_key_hash: hashApiKey(generated.api.key, hashSecret),
    p_encrypted_request_signing_secret: encryptSecret(
      generated.requestSigningSecret,
      encryptionKey,
    ),
    p_scopes: input.scopes ?? defaultScopes,
    p_expires_at: input.expires_at,
    p_encrypted_connector_configuration: connectorConfiguration,
    p_callback_url: input.callback_url,
    p_encrypted_webhook_secret: encryptSecret(generated.webhookSigningSecret, encryptionKey),
    p_technical_contacts: input.technical_contacts ?? [],
    p_allowed_ip_requirements: input.allowed_ip_requirements ?? [],
    p_mtls_details: input.mtls ?? null,
    p_inbound_auth_details: inboundAuthDetails,
  });
  if (error || !data?.[0]) throw new Error('Atomic partner provisioning failed.');
  console.log(
    JSON.stringify(
      {
        warning: 'INITIAL CREDENTIAL ISSUANCE - STORE SECURELY; VALUES CANNOT BE RETRIEVED',
        environment,
        partner_id: partnerId,
        location_id: locationId,
        external_location_id: input.external_location_id,
        scopes: input.scopes ?? defaultScopes,
        expires_at: input.expires_at,
        credential_version: data[0].credential_version,
        api_credential: generated.api.key,
        request_signing_secret: generated.requestSigningSecret,
        webhook_signing_secret: generated.webhookSigningSecret,
      },
      null,
      2,
    ),
  );
}

async function rotate(environment: Environment, input: ProvisioningInput) {
  assertOperatorApproval(environment);
  if (!input.partner_id || !input.location_scopes?.length)
    throw new Error('partner_id and location_scopes are required for rotation.');
  const hashSecret = required('RESTEC_API_KEY_HASH_SECRET');
  const encryptionKey = required('RESTEC_SECRET_ENCRYPTION_KEY');
  const generated = generatedCredential(environment);
  const db = await database();
  const graceSeconds = Number(argument('--grace-seconds') ?? '86400');
  const { data, error } = await db.rpc('rotate_pos_partner_credential', {
    p_partner_id: input.partner_id,
    p_environment: environment,
    p_key_prefix: generated.api.prefix,
    p_key_hash: hashApiKey(generated.api.key, hashSecret),
    p_encrypted_request_signing_secret: encryptSecret(
      generated.requestSigningSecret,
      encryptionKey,
    ),
    p_scopes: input.scopes ?? defaultScopes,
    p_location_scopes: input.location_scopes,
    p_expires_at: input.expires_at,
    p_grace_seconds: graceSeconds,
  });
  if (error || typeof data !== 'number') throw new Error('Credential rotation failed.');
  console.log(
    JSON.stringify(
      {
        warning: 'ROTATED CREDENTIAL - STORE SECURELY; VALUES CANNOT BE RETRIEVED',
        environment,
        partner_id: input.partner_id,
        location_scopes: input.location_scopes,
        scopes: input.scopes ?? defaultScopes,
        expires_at: input.expires_at,
        credential_version: data,
        api_credential: generated.api.key,
        request_signing_secret: generated.requestSigningSecret,
        previous_credential_grace_seconds: graceSeconds,
      },
      null,
      2,
    ),
  );
}

async function revoke() {
  if (!process.argv.includes('--apply'))
    throw new Error('No changes made. Re-run with --apply after reviewing the key prefix.');
  const keyPrefix = argument('--key-prefix');
  if (!keyPrefix) throw new Error('--key-prefix is required.');
  const db = await database();
  const { data, error } = await db.rpc('revoke_pos_partner_credential', {
    p_key_prefix: keyPrefix,
  });
  if (error || data !== true) throw new Error('Credential was not found or could not be revoked.');
  console.log(JSON.stringify({ revoked: true, key_prefix: keyPrefix }));
}

export async function main() {
  const command = process.argv[2];
  if (command === 'revoke') return revoke();
  if (command !== 'provision' && command !== 'rotate')
    throw new Error('Use provision, rotate, or revoke.');
  const environment = argument('--environment');
  if (environment !== 'sandbox' && environment !== 'production')
    throw new Error('--environment must be sandbox or production.');
  const inputPath = argument('--input');
  if (!inputPath) throw new Error('--input is required.');
  const input = validateProvisioningInput(
    JSON.parse(await readFile(resolve(inputPath), 'utf8')) as unknown,
  );
  if (command === 'provision') await provision(environment, input);
  else await rotate(environment, input);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
