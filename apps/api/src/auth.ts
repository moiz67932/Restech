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
    if (!/^req_[A-Za-z0-9._:-]{4,123}$/.test(requestId))
      throw new ApiError(400, 'invalid_request', 'A valid request ID is required.');
    if (config.RESTEC_STRICT_RATE_LIMITING && !rateLimiter)
      throw new ApiError(503, 'dependency_unavailable', 'Request limiting is not configured.');
    const apiKey = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const targetEnvironment = config.RESTEC_ENV === 'production' ? 'production' : 'sandbox';
    const credential = await repo.authenticateApiKey(apiKey, targetEnvironment);
    if (
      !credential ||
      (credential.expiresAt && credential.expiresAt <= new Date()) ||
      (credential.status === 'overlap' &&
        (!credential.graceEndsAt || credential.graceEndsAt <= new Date()))
    ) {
      if (rateLimiter) {
        const source =
          c.req.header('CF-Connecting-IP') ??
          c.req.header('X-Forwarded-For')?.split(',')[0] ??
          'unknown';
        try {
          await rateLimiter.consume({
            key: `auth-failure:${sha256(source)}`,
            limit: 20,
            windowSeconds: 60,
          });
        } catch {
          throw new ApiError(503, 'dependency_unavailable', 'Request limiting is unavailable.');
        }
      }
      throw new ApiError(401, 'invalid_credentials', 'The supplied credentials are invalid.');
    }
    if (rateLimiter) {
      let limited;
      const path = new URL(c.req.url).pathname;
      const rateLimitLocation = path.match(/^\/v1\/locations\/([^/]+)/)?.[1] ?? 'global';
      try {
        limited = await rateLimiter.consume({
          key: `credential:${credential.keyPrefix}:location:${rateLimitLocation}:path:${path}`,
          limit: 100,
          windowSeconds: 60,
        });
      } catch {
        throw new ApiError(503, 'dependency_unavailable', 'Request limiting is unavailable.');
      }
      if (!limited.allowed) {
        c.header('Retry-After', String(limited.retryAfterSeconds));
        throw new ApiError(429, 'rate_limited', 'The request rate limit was exceeded.', {
          retryable: true,
          retry_after_seconds: limited.retryAfterSeconds,
        });
      }
    }
    if (
      credential.environment !== targetEnvironment ||
      (config.RESTEC_ENV === 'production' && !auth.startsWith('Bearer rst_live_')) ||
      (config.RESTEC_ENV !== 'production' && !auth.startsWith('Bearer rst_test_'))
    )
      throw new ApiError(401, 'invalid_credentials', 'The supplied credentials are invalid.');
    const locationId = new URL(c.req.url).pathname.match(/^\/v1\/locations\/([^/]+)/)?.[1];
    if (
      locationId &&
      credential.locationScopes &&
      !credential.locationScopes.includes(decodeURIComponent(locationId))
    )
      throw new ApiError(403, 'access_denied', 'Access to this location is denied.');
    const rawBody = new Uint8Array(await c.req.raw.clone().arrayBuffer());
    if (c.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
      throw new ApiError(400, 'invalid_request', 'Content-Type must be application/json.');
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
    c.header('X-Request-Id', requestId);
    await next();
  };
export const requestHash = (method: string, path: string, raw: Uint8Array) =>
  sha256(Buffer.concat([Buffer.from(`${method}.${path}.`), Buffer.from(raw)]));
