import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

export type RestecEnvironment = 'sandbox' | 'production' | 'test';
export const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export const signRequest = (
  secret: string,
  timestamp: number,
  method: string,
  path: string,
  rawBody: Uint8Array | string,
) =>
  `v1=${createHmac('sha256', secret).update(`${timestamp}.${method.toUpperCase()}.${path}.`).update(rawBody).digest('hex')}`;
export const signEvent = (secret: string, timestamp: number, rawBody: Uint8Array | string) =>
  `v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`;
export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function verifyTimestamp(
  timestamp: number,
  now = Math.floor(Date.now() / 1000),
  tolerance = 300,
): boolean {
  return Number.isSafeInteger(timestamp) && Math.abs(now - timestamp) <= tolerance;
}
export const verifyRequestSignature = (input: {
  secret: string;
  signature: string;
  timestamp: number;
  method: string;
  path: string;
  rawBody: Uint8Array | string;
}) =>
  secureEqual(
    input.signature,
    signRequest(input.secret, input.timestamp, input.method, input.path, input.rawBody),
  );
export const verifyEventSignature = (input: {
  secret: string;
  signature: string;
  timestamp: number;
  rawBody: Uint8Array | string;
}) => secureEqual(input.signature, signEvent(input.secret, input.timestamp, input.rawBody));
export function generateApiKey(environment: 'sandbox' | 'production') {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  return { prefix, key: `rst_${environment === 'sandbox' ? 'test' : 'live'}_${prefix}${secret}` };
}
export const hashApiKey = (key: string, pepper: string) =>
  scryptSync(key, pepper, 32).toString('hex');
export const verifyApiKeyHash = (key: string, pepper: string, expected: string) =>
  secureEqual(hashApiKey(key, pepper), expected);
export function encryptSecret(plaintext: string, base64Key: string): string {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((v) => v.toString('base64url')).join('.');
}
export function decryptSecret(value: string, base64Key: string): string {
  const [ivRaw, tagRaw, dataRaw] = value.split('.');
  if (!ivRaw || !tagRaw || !dataRaw) throw new Error('Invalid ciphertext');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(base64Key, 'base64'),
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
export function assertEnvironmentKey(key: string, environment: RestecEnvironment) {
  if (environment === 'production' && !key.startsWith('rst_live_'))
    throw new Error('Credential environment mismatch');
  if (environment !== 'production' && !key.startsWith('rst_test_'))
    throw new Error('Credential environment mismatch');
}
