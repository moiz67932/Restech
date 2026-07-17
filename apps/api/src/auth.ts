import type { Context, Next } from 'hono';
import { sha256, verifyRequestSignature, verifyTimestamp } from '@restec/security';
import type { Config } from './config.js';
import type { RateLimiter } from '@restec/rate-limiting';
import { ApiError, type Credential, type Repository } from './types.js';
declare module 'hono' {
  interface ContextVariableMap {
    credential: Credential;
    rawBody: Uint8Array;
    requestId: string;
  }
}
export const publicAuth =
  (repo: Repository, config: Config, rateLimiter?: RateLimiter) =>
  async (c: Context, next: Next) => {
    const requestId = c.req.header('X-Request-Id') ?? '';
    const auth = c.req.header('Authorization') ?? '';
    const timestamp = Number(c.req.header('X-Restec-Timestamp'));
    const signature = c.req.header('X-Restec-Signature') ?? '';
    if (!requestId.startsWith('req_'))
      throw new ApiError(400, 'invalid_request', 'A valid request ID is required.');
    const apiKey = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const targetEnvironment = config.RESTEC_ENV === 'production' ? 'production' : 'sandbox';
    const credential = await repo.authenticateApiKey(apiKey, targetEnvironment);
    if (!credential || (credential.expiresAt && credential.expiresAt <= new Date()))
      throw new ApiError(401, 'invalid_credentials', 'The supplied credentials are invalid.');
    if (config.RESTEC_STRICT_RATE_LIMITING && !rateLimiter)
      throw new ApiError(503, 'dependency_unavailable', 'Request limiting is not configured.');
    if (rateLimiter) {
      const limited = await rateLimiter.consume({
        key: `partner:${credential.partnerId}`,
        limit: 100,
        windowSeconds: 60,
      });
      if (!limited.allowed) {
        c.header('Retry-After', String(limited.retryAfterSeconds));
        throw new ApiError(429, 'rate_limited', 'The request rate limit was exceeded.');
      }
    }
    if (
      credential.environment !== targetEnvironment ||
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
    const hash = requestHash(c.req.method, new URL(c.req.url).pathname, rawBody);
    if (
      !(await repo.reserveReplay({
        requestId,
        partnerId: credential.partnerId,
        requestHash: hash,
        environment: targetEnvironment,
        timestamp,
      }))
    )
      throw new ApiError(409, 'replay_detected', 'This request ID has already been used.');
    await repo.recordApiKeyUsage(credential.partnerId, credential.keyPrefix);
    c.set('credential', credential);
    c.set('rawBody', rawBody);
    c.set('requestId', requestId);
    await next();
  };
export const requestHash = (method: string, path: string, raw: Uint8Array) =>
  sha256(Buffer.concat([Buffer.from(`${method}.${path}.`), Buffer.from(raw)]));
