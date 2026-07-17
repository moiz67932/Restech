import { serve } from '@hono/node-server';
import { PaelyClient } from '@restec/paely-client';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { MemoryRepository } from './memory-repository.js';
const config = loadConfig(process.env);
const privateClient = new PaelyClient({
  baseUrl: process.env.PAELY_PRIVATE_BASE_URL ?? '',
  bearerToken: process.env.PAELY_PRIVATE_BEARER_TOKEN ?? '',
  serviceId: process.env.PAELY_SERVICE_ID ?? '',
  environment: config.RESTEC_ENV === 'production' ? 'production' : 'sandbox',
  signingSecret: process.env.PAELY_PRIVATE_SIGNING_SECRET ?? '',
  timeoutMs: config.RESTEC_PRIVATE_REQUEST_TIMEOUT_MS,
});
export const app = createApp({
  repository: new MemoryRepository(),
  privateClient,
  config,
  eventSigningSecret: process.env.PAELY_EVENT_SIGNING_SECRET ?? '',
  internalJobToken: process.env.RESTEC_INTERNAL_JOB_TOKEN ?? '',
});
if (process.env.NODE_ENV !== 'test')
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
