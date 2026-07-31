import assert from 'node:assert/strict';
import test from 'node:test';
import { signEvent } from '@restec/security';
import { createApp } from './app.js';
import { MemoryRepository } from './memory-repository.js';
import type { Config } from './config.js';
const config: Config = {
  NODE_ENV: 'test',
  RESTEC_REPOSITORY_DRIVER: 'memory',
  RESTEC_ENV: 'test' as const,
  RESTEC_PUBLIC_BASE_URL: 'http://localhost',
  RESTEC_PAYMENT_SESSIONS_ENABLED: false,
  RESTEC_PAYMENT_SESSION_TTL_SECONDS: 900,
  RESTEC_ALLOWED_PAYMENT_CHECKOUT_HOSTS: '',
  RESTEC_PAYMENT_SESSION_RETURN_POLL_SECONDS: 2,
  RESTEC_TIMESTAMP_TOLERANCE_SECONDS: 300,
  RESTEC_PRIVATE_REQUEST_TIMEOUT_MS: 1000,
  RESTEC_POS_DELIVERY_TIMEOUT_MS: 1000,
  RESTEC_MAX_DELIVERY_ATTEMPTS: 3,
  RESTEC_DISPATCH_BATCH_SIZE: 10,
  PAELY_PRIVATE_BASE_URL: 'https://private.example',
  PAELY_SERVICE_ID: 'service',
  PAELY_PRIVATE_BEARER_TOKEN: '1234567890123456',
  PAELY_PRIVATE_SIGNING_SECRET: '1234567890123456',
  PAELY_EVENT_SIGNING_SECRET: '1234567890123456',
  PAELY_EVENT_SERVICE_ID: 'paely',
  RESTEC_API_KEY_HASH_SECRET: '12345678901234567890123456789012',
  RESTEC_SECRET_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  RESTEC_INTERNAL_JOB_TOKEN: '1234567890123456',
  RESTEC_STRICT_RATE_LIMITING: false,
};
test('health exposes only safe fields', async () => {
  const app = createApp({
    repository: new MemoryRepository(),
    privateClient: {} as never,
    config,
    eventSigningSecret: 'secret',
    internalJobToken: 'job',
  });
  const response = await app.request('/health');
  assert.deepEqual(await response.json(), { status: 'ok', environment: 'test', version: '1.0.0' });
});
test('private event is durably deduplicated before response', async () => {
  const repo = new MemoryRepository();
  repo.connections.set('con_test', {
    connectionId: 'con_test',
    partnerId: 'ptr_test',
    locationId: 'loc_test',
    environment: 'sandbox',
    connectorType: 'mock_pos',
    connectorVersion: '1.0.0',
    connectorEnabled: true,
    privateLocationId: '00000000-0000-0000-0000-000000000002',
    privateConnectionId: '00000000-0000-0000-0000-000000000001',
    configuration: { failure_mode: 'success' },
  });
  const app = createApp({
    repository: repo,
    privateClient: {} as never,
    config,
    eventSigningSecret: 'secret',
    internalJobToken: 'job',
  });
  const body = JSON.stringify({
    id: 'private-event-1',
    type: 'payment.completed',
    schema_version: '2026-07-01',
    created_at: '2026-07-17T00:00:00Z',
    data: {
      connection_id: '00000000-0000-0000-0000-000000000001',
      location_id: '00000000-0000-0000-0000-000000000002',
      external_bill_id: 'B1',
      external_table_id: 'T1',
      payment: {
        payment_id: 'p1',
        amount: 100,
        currency: 'PKR',
        method: 'card',
        status: 'completed',
      },
      bill: {
        grand_total: 100,
        amount_paid: 100,
        amount_refunded: 0,
        amount_due: 0,
        payment_status: 'paid',
        version: 1,
      },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    'Content-Type': 'application/json',
    'X-Paely-Event-Id': 'private-event-1',
    'X-Paely-Timestamp': String(timestamp),
    'X-Paely-Signature': signEvent('secret', timestamp, body),
    'X-Paely-Delivery-Attempt': '1',
  };
  const first = await app.request('/api/internal/events/paely/v1', {
    method: 'POST',
    headers,
    body,
  });
  assert.equal(first.status, 202, await first.clone().text());
  const second = await app.request('/api/internal/events/paely/v1', {
    method: 'POST',
    headers,
    body,
  });
  assert.equal(second.status, 200);
  assert.equal(repo.events.size, 1);
});

test('sandbox receiver preflight validates identity, environment, HMAC, and exact contract', async () => {
  const app = createApp({
    repository: new MemoryRepository(),
    privateClient: {} as never,
    config,
    eventSigningSecret: 'secret',
    internalJobToken: 'job',
  });
  const event = {
    id: 'contract_0123456789abcdef0123456789abcdef',
    type: 'contract.test',
    schema_version: '2026-07-01',
    created_at: new Date().toISOString(),
    data: {
      contract: 'hosted-payment-session',
      payment_session: {
        restec_payment_session_reference: 'rps_test_contractpreflight',
      },
    },
  };
  const request = async (
    value: typeof event,
    overrides: Record<string, string> = {},
    signingSecret = 'secret',
  ) => {
    const body = JSON.stringify(value);
    const timestamp = Math.floor(Date.now() / 1000);
    return app.request('/api/internal/events/paely/v1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Paely-Event-Id': value.id,
        'X-Paely-Service-Id': 'paely',
        'X-Paely-Environment': 'sandbox',
        'X-Paely-Timestamp': String(timestamp),
        'X-Paely-Signature': signEvent(signingSecret, timestamp, body),
        'X-Paely-Delivery-Attempt': '1',
        ...overrides,
      },
      body,
    });
  };
  assert.equal((await request(event)).status, 202);
  assert.equal(
    (await request(event, { 'X-Paely-Service-Id': 'old-service' })).status,
    401,
  );
  assert.equal(
    (await request(event, { 'X-Paely-Environment': 'production' })).status,
    401,
  );
  assert.equal((await request(event, {}, 'wrong-secret')).status, 401);
  assert.equal(
    (await request({ ...event, schema_version: 'legacy' } as typeof event)).status,
    400,
  );
});

test('legacy generic payload with extra correlation_id remains unsupported', async () => {
  const app = createApp({
    repository: new MemoryRepository(),
    privateClient: {} as never,
    config,
    eventSigningSecret: 'secret',
    internalJobToken: 'job',
  });
  const value = {
    id: 'legacy-event',
    type: 'payment.failed',
    schema_version: '2026-07-01',
    correlation_id: 'legacy-correlation',
    created_at: new Date().toISOString(),
    data: {},
  };
  const body = JSON.stringify(value);
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await app.request('/api/internal/events/paely/v1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Paely-Event-Id': value.id,
      'X-Paely-Timestamp': String(timestamp),
      'X-Paely-Signature': signEvent('secret', timestamp, body),
      'X-Paely-Delivery-Attempt': '1',
    },
    body,
  });
  assert.equal(response.status, 400);
});
