import assert from 'node:assert/strict';
import test from 'node:test';
import { signEvent, signRequest } from '@restec/security';
import { createApp } from './app.js';
import { MemoryRepository } from './memory-repository.js';
import type { Config } from './config.js';

const config: Config = {
  NODE_ENV: 'test',
  RESTEC_REPOSITORY_DRIVER: 'memory',
  RESTEC_ENV: 'test',
  RESTEC_PUBLIC_BASE_URL: 'http://localhost',
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
  RESTEC_API_KEY_HASH_SECRET: '12345678901234567890123456789012',
  RESTEC_SECRET_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  RESTEC_INTERNAL_JOB_TOKEN: '1234567890123456',
  RESTEC_STRICT_RATE_LIMITING: false,
};

test('mock POS bill reaches mock private service and payment event reaches POS outbox', async () => {
  const repo = new MemoryRepository();
  const apiKey = 'rst_test_aaaaaaaaaaaaexample';
  repo.credentials.set(apiKey, {
    partnerId: 'ptr_test',
    environment: 'sandbox',
    signingSecret: 'request-secret',
    status: 'active',
    keyPrefix: 'aaaaaaaaaaaa',
  });
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
    configuration: {
      failure_mode: 'success',
      webhook_url: 'https://1.1.1.1/integrations/restec/webhooks',
    },
  });
  repo.tables.set('table', {
    connection_id: 'con_test',
    table_id: 'tbl_test',
    external_table_id: '12',
    name: 'Table 12',
    active: true,
  });
  let privateCalls = 0;
  const privateClient = {
    async upsertBillDetailed(_location: string, externalBillId: string, input: any) {
      privateCalls++;
      return {
        privateBillReference: 'int_bill_hidden',
        publicState: {
          external_bill_id: externalBillId,
          external_table_id: input.external_table_id,
          sync_status: 'accepted',
          order_status: 'accepted',
          payment_status: 'unpaid',
          table_session_status: 'dining',
          currency: 'PKR',
          grand_total: 10000,
          amount_paid: 0,
          amount_refunded: 0,
          amount_due: 10000,
          version: 1,
          reconciliation_status: 'matched',
          updated_at: new Date().toISOString(),
        },
      };
    },
  } as any;
  const app = createApp({
    repository: repo,
    privateClient,
    config,
    eventSigningSecret: 'event-secret',
    internalJobToken: 'job-secret',
  });
  const path = '/v1/locations/loc_test/bills/INV-1001';
  const body = JSON.stringify({
    external_table_id: '12',
    version: 1,
    currency: 'PKR',
    status: 'open',
    order_status: 'accepted',
    items: [
      {
        external_item_id: 'I1',
        name: 'Meal',
        quantity: 1,
        unit_amount: 10000,
        total_amount: 10000,
      },
    ],
    totals: { subtotal: 10000, tax: 0, service_charge: 0, discount: 0, tip: 0, grand_total: 10000 },
    occurred_at: '2026-07-18T10:30:00Z',
    metadata: {},
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const badSignature = await app.request(path, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Restec-Timestamp': String(timestamp),
      'X-Restec-Signature': signRequest('wrong-secret', timestamp, 'PUT', path, body),
      'X-Request-Id': 'req_mock_bad_signature',
      'Idempotency-Key': 'bill-INV-1001-v1',
    },
    body,
  });
  assert.equal(badSignature.status, 401);
  const billResponse = await app.request(path, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Restec-Timestamp': String(timestamp),
      'X-Restec-Signature': signRequest('request-secret', timestamp, 'PUT', path, body),
      'X-Request-Id': 'req_mock_bill_0001',
      'Idempotency-Key': 'bill-INV-1001-v1',
    },
    body,
  });
  assert.equal(billResponse.status, 200, await billResponse.clone().text());
  assert.equal(privateCalls, 1);
  const publicBill = (await billResponse.json()) as any;
  assert.equal(publicBill.restec_bill_id.startsWith('bil_'), true);
  const publicJson = JSON.stringify(publicBill).toLowerCase();
  for (const forbidden of [
    'int_bill_hidden',
    'paely_order_id',
    'private_table',
    'connection_uuid',
    'stack',
  ])
    assert.equal(publicJson.includes(forbidden), false, `public response exposed ${forbidden}`);
  const replayTimestamp = Math.floor(Date.now() / 1000);
  const replay = await app.request(path, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Restec-Timestamp': String(replayTimestamp),
      'X-Restec-Signature': signRequest('request-secret', replayTimestamp, 'PUT', path, body),
      'X-Request-Id': 'req_mock_bill_replay',
      'Idempotency-Key': 'bill-INV-1001-v1',
    },
    body,
  });
  assert.equal(replay.status, 200);
  assert.equal(privateCalls, 1);
  const conflictingBody = body.replace('"metadata":{}', '"metadata":{"revision":"different"}');
  const conflictTimestamp = Math.floor(Date.now() / 1000);
  const conflict = await app.request(path, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Restec-Timestamp': String(conflictTimestamp),
      'X-Restec-Signature': signRequest(
        'request-secret',
        conflictTimestamp,
        'PUT',
        path,
        conflictingBody,
      ),
      'X-Request-Id': 'req_mock_bill_conflict',
      'Idempotency-Key': 'bill-INV-1001-v1-conflict',
    },
    body: conflictingBody,
  });
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as any).error.code, 'bill_version_conflict');
  assert.equal(privateCalls, 1);

  const eventBody = JSON.stringify({
    id: 'private-event-e2e',
    type: 'payment.completed',
    schema_version: '2026-07-01',
    created_at: new Date().toISOString(),
    data: {
      connection_id: '00000000-0000-0000-0000-000000000001',
      location_id: '00000000-0000-0000-0000-000000000002',
      external_bill_id: 'INV-1001',
      external_table_id: '12',
      payment: {
        payment_id: 'private-payment-1',
        amount: 10000,
        currency: 'PKR',
        method: 'card',
        status: 'completed',
      },
      bill: {
        grand_total: 10000,
        amount_paid: 10000,
        amount_refunded: 0,
        amount_due: 0,
        payment_status: 'paid',
        version: 1,
      },
    },
  });
  const eventTs = Math.floor(Date.now() / 1000);
  const accepted = await app.request('/api/internal/events/paely/v1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Paely-Event-Id': 'private-event-e2e',
      'X-Paely-Timestamp': String(eventTs),
      'X-Paely-Signature': signEvent('event-secret', eventTs, eventBody),
      'X-Paely-Delivery-Attempt': '1',
    },
    body: eventBody,
  });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  assert.equal(repo.outbox.size, 1);
  const dispatch = await app.request('/api/internal/jobs/dispatch-pos-events', {
    method: 'POST',
    headers: { Authorization: 'Bearer job-secret' },
  });
  assert.equal(dispatch.status, 202);
  const dispatchBody = (await dispatch.json()) as any;
  assert.equal(
    dispatchBody.delivered,
    1,
    JSON.stringify({ dispatchBody, attempts: repo.attempts }),
  );
  assert.equal(repo.outbox.size, 0);
  assert.equal(repo.attempts.length, 1);
  assert.equal((await repo.getBill('con_test', 'INV-1001'))?.payment_status, 'paid');
});
