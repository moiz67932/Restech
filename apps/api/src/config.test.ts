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
test('string false does not enable strict rate limiting', () =>
  assert.equal(
    loadConfig({ ...env, RESTEC_STRICT_RATE_LIMITING: 'false' }).RESTEC_STRICT_RATE_LIMITING,
    false,
  ));
test('blank optional and defaulted variables are treated as unset', () => {
  const config = loadConfig({
    ...env,
    NODE_ENV: '',
    RESTEC_DATABASE_URL: '',
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    RESTEC_WEBHOOK_MASTER_KEY: '',
    RESTEC_TIMESTAMP_TOLERANCE_SECONDS: '',
    RESTEC_PRIVATE_REQUEST_TIMEOUT_MS: '',
    RESTEC_POS_DELIVERY_TIMEOUT_MS: '',
    RESTEC_MAX_DELIVERY_ATTEMPTS: '',
    RESTEC_DISPATCH_BATCH_SIZE: '',
    RESTEC_STRICT_RATE_LIMITING: '',
    RESTEC_SHARED_RATE_LIMITER_URL: '',
    RESTEC_SHARED_RATE_LIMITER_TOKEN: '',
    CRON_SECRET: '',
  });
  assert.equal(config.NODE_ENV, 'development');
  assert.equal(config.RESTEC_TIMESTAMP_TOLERANCE_SECONDS, 300);
  assert.equal(config.RESTEC_PRIVATE_REQUEST_TIMEOUT_MS, 5000);
  assert.equal(config.RESTEC_POS_DELIVERY_TIMEOUT_MS, 5000);
  assert.equal(config.RESTEC_MAX_DELIVERY_ATTEMPTS, 10);
  assert.equal(config.RESTEC_DISPATCH_BATCH_SIZE, 25);
  assert.equal(config.RESTEC_STRICT_RATE_LIMITING, false);
  assert.equal(config.SUPABASE_URL, undefined);
  assert.equal(config.CRON_SECRET, undefined);
});
