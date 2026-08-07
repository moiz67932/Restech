import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { signRequest, sha256 } from '@restec/security';
import type { CanonicalExternalPaymentInput } from '@restec/contracts';
import { createApp } from './app.js';
import type { Config } from './config.js';
import { MemoryRepository } from './memory-repository.js';

const bill = (total = 10_000) => ({
  request_id: 'req_seed',
  restec_bill_id: 'bil_financial_capacity',
  external_bill_id: 'BILL-CAPACITY',
  external_table_id: 'TABLE-1',
  sync_status: 'accepted' as const,
  order_status: 'accepted',
  payment_status: 'unpaid',
  table_session_status: 'payment_due',
  currency: 'PKR',
  grand_total: total,
  amount_paid: 0,
  amount_refunded: 0,
  amount_due: total,
  version: 1,
  reconciliation_status: 'matched',
  updated_at: '2026-08-07T00:00:00Z',
});

const repository = (total = 10_000) => {
  const repo = new MemoryRepository();
  repo.bills.set('con_capacity:BILL-CAPACITY', bill(total));
  repo.billRequests.set('con_capacity:BILL-CAPACITY', {
    version: 1,
    requestHash: 'seed-hash',
  });
  return repo;
};

const reserve = (
  repo: MemoryRepository,
  identity: string,
  amountMinor: number,
  channel: 'external_payment' | 'digital_session' = 'external_payment',
) =>
  repo.reserveBillCapacity({
    connectionId: 'con_capacity',
    externalBillId: 'BILL-CAPACITY',
    reservationIdentity: identity,
    channel,
    amountMinor,
    currency: 'PKR',
    requestHash: sha256(identity),
  });

test('Financial capacity invariants: two cash payments serialize before downstream', async () => {
  const repo = repository(5_000);
  const outcomes = await Promise.allSettled([
    reserve(repo, 'external_payment:CASH-A', 5_000),
    reserve(repo, 'external_payment:CASH-B', 5_000),
  ]);
  assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((value) => value.status === 'rejected').length, 1);
  assert.equal(
    [...repo.financialReservations.values()]
      .filter((value) => value.state === 'reserved')
      .reduce((sum, value) => sum + value.amountMinor, 0),
    5_000,
  );
});

test('Concurrent payment serialization: cash, terminal, and digital share capacity', async () => {
  for (const [leftChannel, rightChannel] of [
    ['external_payment', 'external_payment'],
    ['external_payment', 'digital_session'],
  ] as const) {
    const repo = repository(5_000);
    const outcomes = await Promise.allSettled([
      reserve(repo, `external_payment:${leftChannel}-A`, 5_000, leftChannel),
      reserve(repo, `payment_session:${rightChannel}-B`, 5_000, rightChannel),
    ]);
    assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 1);
    assert.equal(
      [...repo.financialReservations.values()].reduce((sum, value) => sum + value.amountMinor, 0),
      5_000,
    );
  }
});

test('Payment reservation lifecycle: only one digital session is active', async () => {
  const repo = repository();
  const outcomes = await Promise.allSettled([
    reserve(repo, 'payment_session:DIGITAL-A', 4_000, 'digital_session'),
    reserve(repo, 'payment_session:DIGITAL-B', 6_000, 'digital_session'),
  ]);
  assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(
    [...repo.financialReservations.values()].filter((value) => value.channel === 'digital_session')
      .length,
    1,
  );
});

test('Crash and ambiguous-outcome recovery: uncertain capacity is never reused', async () => {
  const repo = repository(5_000);
  const first = 'external_payment:UNKNOWN-A';
  await reserve(repo, first, 5_000);
  await repo.markFinancialReservationAmbiguous('con_capacity', first, sha256(first));
  await assert.rejects(reserve(repo, 'external_payment:CASH-B', 5_000), {
    message: 'payment_capacity_conflict',
  });
  const retry = await reserve(repo, first, 5_000);
  assert.equal(retry.created, false);
  assert.equal(retry.state, 'ambiguous_pending_reconciliation');
  assert.equal(retry.projection.availableMinor, 0);
});

test('Bill financial-floor invariants: update and payment cannot cross protected capacity', async () => {
  const repo = repository();
  await reserve(repo, 'external_payment:CASH-A', 8_000);
  await assert.rejects(
    repo.reserveBillMutation({
      connectionId: 'con_capacity',
      externalBillId: 'BILL-CAPACITY',
      version: 2,
      requestHash: 'bill-v2',
      newTotalMinor: 7_000,
      currency: 'PKR',
    }),
    { message: 'bill_financial_floor_conflict' },
  );
  assert.equal(repo.pendingBillMutations.size, 0);
});

test('Concurrent bill update and payment leave one legal protected state', async () => {
  const repo = repository();
  const outcomes = await Promise.allSettled([
    reserve(repo, 'external_payment:PAYMENT-RACE', 8_000),
    repo.reserveBillMutation({
      connectionId: 'con_capacity',
      externalBillId: 'BILL-CAPACITY',
      version: 2,
      requestHash: 'bill-race-v2',
      newTotalMinor: 7_000,
      currency: 'PKR',
    }),
  ]);
  assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 1);
  const protectedMinor = [...repo.financialReservations.values()].reduce(
    (sum, value) => sum + value.amountMinor,
    0,
  );
  const effectiveTotal = [...repo.pendingBillMutations.values()][0]?.newTotalMinor ?? 10_000;
  assert.ok(protectedMinor <= effectiveTotal);
});

test('Financial capacity stress: 100 full-balance requests commit exactly one payment', async () => {
  const repo = repository();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 100 }, (_, index) =>
      reserve(repo, `external_payment:FULL-${index}`, 10_000),
    ),
  );
  assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 1);
  const winner = [...repo.financialReservations.values()][0]!;
  const input: CanonicalExternalPaymentInput = {
    external_payment_id: winner.reservationIdentity.replace('external_payment:', ''),
    method: 'cash',
    amount: 10_000,
    currency: 'PKR',
    status: 'completed',
    occurred_at: '2026-08-07T00:01:00Z',
    metadata: {},
  };
  const paid = { ...bill(), payment_status: 'paid', amount_paid: 10_000, amount_due: 0 };
  await repo.saveExternalPayment('con_capacity', 'BILL-CAPACITY', input, paid, winner.requestHash);
  assert.equal(
    [...repo.financialReservations.values()]
      .filter((value) => value.state === 'completed')
      .reduce((sum, value) => sum + value.amountMinor, 0),
    10_000,
  );
});

test('Completed reservation facts prevent a stale downstream projection from reopening capacity', async () => {
  const repo = repository();
  await reserve(repo, 'external_payment:PART-A', 5_000);
  await reserve(repo, 'external_payment:PART-B', 5_000);
  const payment = (id: string): CanonicalExternalPaymentInput => ({
    external_payment_id: id,
    method: 'cash',
    amount: 5_000,
    currency: 'PKR',
    status: 'completed',
    occurred_at: '2026-08-07T00:01:00Z',
    metadata: {},
  });
  await repo.saveExternalPayment(
    'con_capacity',
    'BILL-CAPACITY',
    payment('PART-B'),
    { ...bill(), amount_paid: 10_000, amount_due: 0, payment_status: 'paid' },
    sha256('external_payment:PART-B'),
  );
  await repo.saveExternalPayment(
    'con_capacity',
    'BILL-CAPACITY',
    payment('PART-A'),
    { ...bill(), amount_paid: 5_000, amount_due: 5_000, payment_status: 'partially_paid' },
    sha256('external_payment:PART-A'),
  );
  await assert.rejects(reserve(repo, 'external_payment:ILLEGAL-REOPEN', 1), {
    message: 'payment_capacity_conflict',
  });
});

test('Exactly-once financial completion: a new event ID cannot emit a second POS event', async () => {
  const repo = repository(5_000);
  repo.connections.set('con_capacity', {
    connectionId: 'con_capacity',
    partnerId: 'ptr_capacity',
    locationId: 'loc_capacity',
    environment: 'sandbox',
    connectorType: 'mock_pos',
    connectorVersion: '1.0.0',
    connectorEnabled: true,
    privateLocationId: '00000000-0000-4000-8000-000000000002',
    privateConnectionId: '00000000-0000-4000-8000-000000000001',
    configuration: {},
  });
  const publicSessionId = 'rps_test_duplicatecompletion';
  await reserve(repo, `payment_session:${publicSessionId}`, 5_000, 'digital_session');
  repo.paymentSessions.set(publicSessionId, {
    id: '00000000-0000-4000-8000-000000000010',
    publicPaymentSessionId: publicSessionId,
    environment: 'sandbox',
    partnerId: 'ptr_capacity',
    connectionId: 'con_capacity',
    locationId: 'loc_capacity',
    externalBillId: 'BILL-CAPACITY',
    privateLocationReference: '00000000-0000-4000-8000-000000000002',
    privateConnectionReference: '00000000-0000-4000-8000-000000000001',
    privatePaymentSessionReference: 'private-session-1',
    method: 'card',
    amountMinor: 5_000,
    currency: 'PKR',
    status: 'requires_customer_action',
    expiresAt: '2026-08-07T01:00:00Z',
    idempotencyKey: 'session-key',
    requestFingerprint: sha256(`payment_session:${publicSessionId}`),
    createdAt: '2026-08-07T00:00:00Z',
    updatedAt: '2026-08-07T00:00:00Z',
  });
  const event = (suffix: string) =>
    ({
      privateEventId: `private-event-${suffix}`,
      eventType: 'payment.completed',
      schemaVersion: '2026-07-01',
      connectionId: 'con_capacity',
      requestHash: sha256(`event-${suffix}`),
      payload: {
        data: {
          connection_id: '00000000-0000-4000-8000-000000000001',
          location_id: '00000000-0000-4000-8000-000000000002',
          external_bill_id: 'BILL-CAPACITY',
          payment: { amount: 5_000, currency: 'PKR', method: 'card' },
          payment_session: { private_payment_session_id: 'private-session-1', status: 'paid' },
        },
      },
      publicEventId: `evt_${suffix}`,
      publicPayload: {
        id: `evt_${suffix}`,
        type: 'payment.completed',
        schema_version: '2026-07-01',
        created_at: '2026-08-07T00:02:00Z',
        data: {
          location_id: 'loc_capacity',
          external_bill_id: 'BILL-CAPACITY',
          external_table_id: 'TABLE-1',
          payment_session_id: publicSessionId,
          payment: {
            restec_payment_id: 'pay_duplicatecompletion',
            amount: 5_000,
            currency: 'PKR',
            method: 'card',
            status: 'completed',
          },
          bill: {
            grand_total: 5_000,
            amount_paid: 5_000,
            amount_refunded: 0,
            amount_due: 0,
            payment_status: 'paid',
            version: 2,
          },
        },
      },
      publicPaymentSessionId: publicSessionId,
      requestedStatus: 'paid',
    }) as any;
  assert.equal((await repo.acceptPaymentSessionEvent(event('one'))).duplicate, false);
  assert.equal((await repo.acceptPaymentSessionEvent(event('two'))).duplicate, true);
  assert.equal(repo.outbox.size, 1);
  assert.equal(
    [...repo.financialReservations.values()].filter((value) => value.state === 'completed').length,
    1,
  );
});

test('Financial capacity stress: 100 partial conflicts never protect more than total', async () => {
  const repo = repository();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 100 }, (_, index) => reserve(repo, `external_payment:PART-${index}`, 200)),
  );
  assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 50);
  assert.equal(
    [...repo.financialReservations.values()].reduce((sum, value) => sum + value.amountMinor, 0),
    10_000,
  );
});

test('Property stress: randomized identities never make available capacity negative', async () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  for (let run = 0; run < 50; run++) {
    const repo = repository();
    for (let step = 0; step < 100; step++) {
      const amount = 1 + Math.floor(random() * 2_000);
      const identity = `external_payment:R${run}-${step}`;
      try {
        await reserve(repo, identity, amount);
        if (random() < 0.2)
          await repo.markFinancialReservationAmbiguous('con_capacity', identity, sha256(identity));
      } catch {
        // Capacity conflicts are expected generated outcomes.
      }
      const protectedMinor = [...repo.financialReservations.values()]
        .filter((value) => ['reserved', 'ambiguous_pending_reconciliation'].includes(value.state))
        .reduce((sum, value) => sum + value.amountMinor, 0);
      assert.ok(protectedMinor <= 10_000);
    }
  }
});

test('Migration contains locked reserve, atomic commit, ambiguity, and financial-floor guards', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260807000100_financial_capacity_reservations.sql'),
    'utf8',
  );
  for (const predicate of [
    /create or replace function public\.reserve_bill_capacity/,
    /for update/,
    /ambiguous_pending_reconciliation/,
    /create or replace function public\.persist_restec_external_payment/,
    /create or replace function public\.accept_payment_session_event/,
    /when s\.status in \('paid','refunded','partially_refunded'\) then 'completed'/,
    /create or replace function public\.reserve_bill_mutation/,
    /bill_financial_floor_conflict/,
    /payment_capacity_conflict/,
    /financial_reservations_one_active_digital_bill_idx/,
  ])
    assert.match(migration, predicate);
});

test('Real HTTP concurrency: losing cash request cannot reach downstream', async () => {
  const repo = repository(5_000);
  const apiKey = 'rst_test_financialcapacity';
  repo.credentials.set(apiKey, {
    partnerId: 'ptr_capacity',
    environment: 'sandbox',
    signingSecret: 'request-secret',
    status: 'active',
    keyPrefix: 'capacity',
    scopes: ['payments:write'],
    locationScopes: ['loc_capacity'],
  });
  repo.connections.set('con_capacity', {
    connectionId: 'con_capacity',
    partnerId: 'ptr_capacity',
    locationId: 'loc_capacity',
    environment: 'sandbox',
    connectorType: 'mock_pos',
    connectorVersion: '1.0.0',
    connectorEnabled: true,
    privateLocationId: '00000000-0000-4000-8000-000000000002',
    privateConnectionId: '00000000-0000-4000-8000-000000000001',
    configuration: {},
  });
  let downstreamCalls = 0;
  const app = createApp({
    repository: repo,
    privateClient: {
      async recordExternalPayment(_location: string, externalBillId: string, input: any) {
        downstreamCalls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          ...bill(5_000),
          external_bill_id: externalBillId,
          payment_status: 'paid',
          amount_paid: input.amount,
          amount_due: 0,
        };
      },
    } as any,
    config: {
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
    } satisfies Config,
    eventSigningSecret: 'event-secret',
    internalJobToken: 'job-secret',
  });
  const path = '/v1/locations/loc_capacity/bills/BILL-CAPACITY/external-payments';
  const send = (id: string) => {
    const body = JSON.stringify({
      external_payment_id: id,
      method: 'cash',
      amount: 5_000,
      currency: 'PKR',
      status: 'completed',
      occurred_at: '2026-08-07T00:01:00Z',
      metadata: {},
    });
    const timestamp = Math.floor(Date.now() / 1000);
    return app.request(path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Restec-Timestamp': String(timestamp),
        'X-Restec-Signature': signRequest('request-secret', timestamp, 'POST', path, body),
        'X-Request-Id': `req_${id.replaceAll('-', '')}000000000000000000000000`,
        'Idempotency-Key': `key-${id}`,
      },
      body,
    });
  };
  const responses = await Promise.all([send('CASH-A'), send('CASH-B')]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(downstreamCalls, 1);
  assert.equal(repo.bills.get('con_capacity:BILL-CAPACITY')!.amount_paid, 5_000);
});
