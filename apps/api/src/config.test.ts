import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.js';
const env = {
  NODE_ENV: 'test',
  RESTEC_ENV: 'test',
  RESTEC_REPOSITORY_DRIVER: 'memory',
  RESTEC_PUBLIC_BASE_URL: 'http://localhost:3000',
  PAELY_PRIVATE_BASE_URL: 'https://private.example',
  PAELY_SERVICE_ID: 'service',
  PAELY_PRIVATE_BEARER_TOKEN: '1234567890123456',
  PAELY_PRIVATE_SIGNING_SECRET: '1234567890123456',
  PAELY_EVENT_SIGNING_SECRET: '1234567890123456',
  RESTEC_API_KEY_HASH_SECRET: '12345678901234567890123456789012',
  RESTEC_SECRET_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  RESTEC_INTERNAL_JOB_TOKEN: '1234567890123456',
};
test('memory driver is accepted only for explicit test configuration', () =>
  assert.equal(loadConfig(env).RESTEC_REPOSITORY_DRIVER, 'memory'));
test('sandbox refuses memory repository', () =>
  assert.throws(() => loadConfig({ ...env, RESTEC_ENV: 'sandbox' }), /supabase is required/));
test('Supabase driver fails fast without server credentials', () =>
  assert.throws(
    () => loadConfig({ ...env, RESTEC_ENV: 'sandbox', RESTEC_REPOSITORY_DRIVER: 'supabase' }),
    /configuration is incomplete/,
  ));
