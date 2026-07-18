import { createClient } from '@supabase/supabase-js';
import { PaelyClient } from '@restec/paely-client';
import { SupabaseRepository, type RestecRepository } from '@restec/database';
import { createApp } from './app.js';
import { loadConfig, sanitizedConfig } from './config.js';
import { MemoryRepository } from './memory-repository.js';
import { HttpSharedRateLimiter } from '@restec/rate-limiting';
export const config = loadConfig(process.env);
const repository: RestecRepository =
  config.RESTEC_REPOSITORY_DRIVER === 'memory'
    ? new MemoryRepository()
    : new SupabaseRepository(
        createClient(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!, {
          auth: { persistSession: false, autoRefreshToken: false },
        }),
        {
          apiKeyHashSecret: config.RESTEC_API_KEY_HASH_SECRET,
          secretEncryptionKey: config.RESTEC_SECRET_ENCRYPTION_KEY,
        },
      );
const privateClient = new PaelyClient({
  baseUrl: config.PAELY_PRIVATE_BASE_URL,
  bearerToken: config.PAELY_PRIVATE_BEARER_TOKEN,
  serviceId: config.PAELY_SERVICE_ID,
  environment: config.RESTEC_ENV === 'production' ? 'production' : 'sandbox',
  signingSecret: config.PAELY_PRIVATE_SIGNING_SECRET,
  timeoutMs: config.RESTEC_PRIVATE_REQUEST_TIMEOUT_MS,
});
const rateLimiter =
  config.RESTEC_SHARED_RATE_LIMITER_URL && config.RESTEC_SHARED_RATE_LIMITER_TOKEN
    ? new HttpSharedRateLimiter(
        config.RESTEC_SHARED_RATE_LIMITER_URL,
        config.RESTEC_SHARED_RATE_LIMITER_TOKEN,
      )
    : undefined;
export const app = createApp({
  repository,
  privateClient,
  config,
  eventSigningSecret: config.PAELY_EVENT_SIGNING_SECRET,
  internalJobToken: config.RESTEC_INTERNAL_JOB_TOKEN,
  ...(rateLimiter ? { rateLimiter } : {}),
});
if (config.NODE_ENV !== 'test')
  console.info(JSON.stringify({ event: 'restec.configuration', ...sanitizedConfig(config) }));
