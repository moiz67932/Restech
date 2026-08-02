import assert from 'node:assert/strict';
import test from 'node:test';
import { signRequest } from '@restec/security';
import { createApp } from './app.js';
import { MemoryRepository } from './memory-repository.js';
import type { Config } from './config.js';

const config: Config = {
  NODE_ENV: 'test',
  RESTEC_REPOSITORY_DRIVER: 'memory',
  RESTEC_ENV: 'test',
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
  PAELY_PRIVATE_BASE_URL: 'https://managed.example',
  PAELY_SERVICE_ID: 'service',
  PAELY_PRIVATE_BEARER_TOKEN: '1234567890123456',
  PAELY_PRIVATE_SIGNING_SECRET: '1234567890123456',
  PAELY_EVENT_SIGNING_SECRET: '1234567890123456',
  PAELY_EVENT_SERVICE_ID: 'managed',
  RESTEC_API_KEY_HASH_SECRET: '12345678901234567890123456789012',
  RESTEC_SECRET_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  RESTEC_INTERNAL_JOB_TOKEN: '1234567890123456',
  RESTEC_STRICT_RATE_LIMITING: false,
};

function fixture() {
  const repo = new MemoryRepository();
  const apiKey = 'rst_test_scopedexample';
  repo.credentials.set(apiKey, {
    partnerId: 'ptr_partner',
    environment: 'sandbox',
    signingSecret: 'request-secret',
    status: 'active',
    keyPrefix: 'scoped',
    scopes: ['bills:read', 'payments:write'],
    locationScopes: ['loc_allowed'],
    credentialVersion: 2,
  });
  for (const [connectionId, locationId] of [
    ['con_allowed', 'loc_allowed'],
    ['con_denied', 'loc_denied'],
  ] as const)
    repo.connections.set(connectionId, {
      connectionId,
      partnerId: 'ptr_partner',
      locationId,
      environment: 'sandbox',
      connectorType: 'mock_pos',
      connectorVersion: '1.0.0',
      connectorEnabled: true,
      privateLocationId: '00000000-0000-4000-8000-000000000002',
      privateConnectionId:
        connectionId === 'con_allowed'
          ? '00000000-0000-4000-8000-000000000001'
          : '00000000-0000-4000-8000-000000000003',
      configuration: {},
    });
  const initialBill = {
    request_id: 'req_seed',
    restec_bill_id: 'bil_seed',
    external_bill_id: 'BILL-1',
    external_table_id: 'TABLE-1',
    sync_status: 'accepted' as const,
    order_status: 'accepted',
    payment_status: 'unpaid',
    table_session_status: 'payment_due',
    currency: 'PKR',
    grand_total: 10_000,
    amount_paid: 0,
    amount_refunded: 0,
    amount_due: 10_000,
    version: 1,
    reconciliation_status: 'matched',
    updated_at: '2026-08-02T00:00:00Z',
  };
  repo.bills.set('con_allowed:BILL-1', initialBill);
  let calls = 0;
  const privateClient = {
    async recordExternalPayment(_location: string, externalBillId: string, input: any) {
      calls++;
      return {
        ...initialBill,
        external_bill_id: externalBillId,
        amount_paid: input.amount,
        amount_due: 10_000 - input.amount,
        payment_status: input.amount === 10_000 ? 'paid' : 'partially_paid',
        updated_at: input.occurred_at,
      };
    },
  } as any;
  return {
    app: createApp({
      repository: repo,
      privateClient,
      config,
      eventSigningSecret: 'event-secret',
      internalJobToken: 'job-secret',
    }),
    repo,
    apiKey,
    calls: () => calls,
  };
}

async function signed(
  app: ReturnType<typeof createApp>,
  apiKey: string,
  method: string,
  path: string,
  body = '',
  requestId = `req_${Math.random().toString(36).slice(2)}_test`,
  idempotencyKey?: string,
) {
  const timestamp = Math.floor(Date.now() / 1000);
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Restec-Timestamp': String(timestamp),
      'X-Restec-Signature': signRequest('request-secret', timestamp, method, path, body),
      'X-Request-Id': requestId,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(method === 'GET' ? {} : { body }),
  });
}

const payment = (method: 'cash' | 'card_terminal', amount = 10_000, currency = 'PKR') =>
  JSON.stringify({
    external_payment_id: `PAY-${method}`,
    method,
    amount,
    currency,
    status: 'completed',
    occurred_at: '2026-08-02T10:00:00Z',
    metadata: {},
  });

test('traditional cash payment is location-scoped, audited, and idempotent', async () => {
  const { app, repo, apiKey, calls } = fixture();
  const path = '/v1/locations/loc_allowed/bills/BILL-1/external-payments';
  const body = payment('cash');
  const first = await signed(app, apiKey, 'POST', path, body, 'req_cash_first', 'cash-payment-1');
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(((await first.json()) as any).payment_status, 'paid');
  const replay = await signed(app, apiKey, 'POST', path, body, 'req_cash_retry', 'cash-payment-1');
  assert.equal(replay.status, 200);
  assert.equal(calls(), 1);
  assert.equal(repo.payments.size, 1);
  assert.equal(
    repo.audits.filter((value) => value.action === 'external_payment.recorded').length,
    1,
  );
});

test('physical-terminal payment is accepted and conflicting duplicate is rejected', async () => {
  const { app, apiKey, calls } = fixture();
  const path = '/v1/locations/loc_allowed/bills/BILL-1/external-payments';
  const body = payment('card_terminal');
  assert.equal(
    (await signed(app, apiKey, 'POST', path, body, 'req_terminal_first', 'terminal-payment-1'))
      .status,
    200,
  );
  const conflict = await signed(
    app,
    apiKey,
    'POST',
    path,
    body.replace('10000', '9000'),
    'req_terminal_conflict',
    'terminal-payment-1',
  );
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as any).code, 'idempotency_conflict');
  assert.equal(calls(), 1);
});

test('wrong location, missing operation scope, expiry, and rotation grace are enforced', async () => {
  const { app, repo, apiKey } = fixture();
  const wrongLocation = await signed(
    app,
    apiKey,
    'GET',
    '/v1/locations/loc_denied/bills/BILL-1',
    '',
    'req_wrong_location',
  );
  assert.equal(wrongLocation.status, 403);
  assert.equal(((await wrongLocation.json()) as any).code, 'access_denied');

  const missingScope = await signed(
    app,
    apiKey,
    'PUT',
    '/v1/locations/loc_allowed/bills/BILL-1',
    '{}',
    'req_missing_scope',
    'bill-write',
  );
  assert.equal(missingScope.status, 403);

  const expiredKey = 'rst_test_expiredexample';
  repo.credentials.set(expiredKey, {
    ...repo.credentials.get(apiKey),
    keyPrefix: 'expired',
    expiresAt: new Date(Date.now() - 1000),
  });
  assert.equal(
    (
      await signed(
        app,
        expiredKey,
        'GET',
        '/v1/locations/loc_allowed/bills/BILL-1',
        '',
        'req_expired_credential',
      )
    ).status,
    401,
  );

  const oldKey = 'rst_test_overlapexample';
  repo.credentials.set(oldKey, {
    ...repo.credentials.get(apiKey),
    keyPrefix: 'overlap',
    status: 'overlap',
    graceEndsAt: new Date(Date.now() - 1000),
  });
  assert.equal(
    (
      await signed(
        app,
        oldKey,
        'GET',
        '/v1/locations/loc_allowed/bills/BILL-1',
        '',
        'req_rotated_credential',
      )
    ).status,
    401,
  );
});

test('amount and currency mismatch returns a validation problem without a financial write', async () => {
  const { app, apiKey, calls } = fixture();
  const path = '/v1/locations/loc_allowed/bills/BILL-1/external-payments';
  const response = await signed(
    app,
    apiKey,
    'POST',
    path,
    payment('cash', 10_000, 'USD'),
    'req_currency_mismatch',
    'currency-mismatch',
  );
  assert.equal(response.status, 422);
  assert.equal(((await response.json()) as any).code, 'amount_mismatch');
  assert.equal(calls(), 0);
});
