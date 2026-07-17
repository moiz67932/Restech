import type { Context, Next } from 'hono';
import { sha256, verifyRequestSignature, verifyTimestamp } from '@restec/security';
import type { Config } from './config.js';
import { ApiError, type Credential, type Repository } from './types.js';
declare module 'hono' {
  interface ContextVariableMap {
    credential: Credential;
    rawBody: Uint8Array;
    requestId: string;
  }
}
export const publicAuth = (repo: Repository, config: Config) => async (c: Context, next: Next) => {
  const requestId = c.req.header('X-Request-Id') ?? '';
  const auth = c.req.header('Authorization') ?? '';
  const timestamp = Number(c.req.header('X-Restec-Timestamp'));
  const signature = c.req.header('X-Restec-Signature') ?? '';
  if (!requestId.startsWith('req_'))
    throw new ApiError(400, 'invalid_request', 'A valid request ID is required.');
  const credential = await repo.findCredential(auth.startsWith('Bearer ') ? auth.slice(7) : '');
  if (
    !credential ||
    credential.status === 'revoked' ||
    (credential.expiresAt && credential.expiresAt <= new Date())
  )
    throw new ApiError(401, 'invalid_credentials', 'The supplied credentials are invalid.');
  if (
    credential.environment !== config.RESTEC_ENV ||
    (config.RESTEC_ENV === 'production' && !auth.startsWith('Bearer rst_live_')) ||
    (config.RESTEC_ENV !== 'production' && !auth.startsWith('Bearer rst_test_'))
  )
    throw new ApiError(401, 'invalid_credentials', 'The supplied credentials are invalid.');
  const rawBody = new Uint8Array(await c.req.raw.clone().arrayBuffer());
  if (rawBody.byteLength > 1_048_576)
    throw new ApiError(413, 'payload_too_large', 'The request payload is too large.');
  if (
    !verifyTimestamp(timestamp, undefined, config.RESTEC_TIMESTAMP_TOLERANCE_SECONDS) ||
    !verifyRequestSignature({
      secret: credential.signingSecret,
      signature,
      timestamp,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      rawBody,
    })
  )
    throw new ApiError(401, 'invalid_credentials', 'The request signature is invalid.');
  if (!(await repo.consumeRequestId(requestId, credential.partnerId)))
    throw new ApiError(409, 'replay_detected', 'This request ID has already been used.');
  c.set('credential', credential);
  c.set('rawBody', rawBody);
  c.set('requestId', requestId);
  await next();
};
export const requestHash = (method: string, path: string, raw: Uint8Array) =>
  sha256(Buffer.concat([Buffer.from(`${method}.${path}.`), Buffer.from(raw)]));
