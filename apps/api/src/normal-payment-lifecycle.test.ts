import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { sha256 } from '@restec/security';
import { ReconciliationService } from './reconciliation.js';
import { MemoryRepository } from './memory-repository.js';

const sessionId = 'rps_test_phase4lifecycle000001';

function fixture() {
  const repo = new MemoryRepository();
  const connection = {
    connectionId: 'con_phase4',
    partnerId: 'ptr_phase4',
    locationId: 'loc_phase4',
    environment: 'sandbox' as const,
    connectorType: 'mock_pos',
    connectorVersion: '1.0.0',
    connectorEnabled: true,
    privateLocationId: '00000000-0000-4000-8000-000000000002',
    privateConnectionId: '00000000-0000-4000-8000-000000000001',
    configuration: {},
  };
  const bill = {
    request_id: 'req_phase4_seed',
    restec_bill_id: 'bil_phase4',
    external_bill_id: 'BILL-PHASE4',
    external_table_id: 'TABLE-PHASE4',
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
    updated_at: '2026-08-07T00:00:00.000Z',
  };
  repo.connections.set(connection.connectionId, connection);
  repo.bills.set(`${connection.connectionId}:${bill.external_bill_id}`, bill);
  repo.financialReservations.set(`${connection.connectionId}:payment_session:${sessionId}`, {
    connectionId: connection.connectionId,
    externalBillId: bill.external_bill_id,
    reservationIdentity: `payment_session:${sessionId}`,
    channel: 'digital_session',
    amountMinor: 5_000,
    currency: 'PKR',
    requestHash: sha256(sessionId),
    expiresAt: '2026-08-06T23:59:00.000Z',
    state: 'reserved',
  });
  repo.paymentSessions.set(sessionId, {
    id: 'phase4-session-row',
    publicPaymentSessionId: sessionId,
    environment: 'sandbox',
    partnerId: connection.partnerId,
    connectionId: connection.connectionId,
    locationId: connection.locationId,
    externalBillId: bill.external_bill_id,
    privateLocationReference: connection.privateLocationId,
    privateConnectionReference: connection.privateConnectionId,
    privatePaymentSessionReference: 'private-phase4-session',
    method: 'card',
    amountMinor: 5_000,
    currency: 'PKR',
    status: 'requires_customer_action',
    expiresAt: '2026-08-06T23:59:00.000Z',
    idempotencyKey: 'phase4-session',
    requestFingerprint: sha256(sessionId),
    createdAt: '2026-08-06T23:00:00.000Z',
    updatedAt: '2026-08-06T23:00:00.000Z',
  });
  let providerStatus:
    'requires_customer_action' | 'processing' | 'paid' | 'failed' | 'cancelled' | 'expired' =
    'requires_customer_action';
  const privateClient = {
    async getPaymentSession() {
      return {
        privatePaymentSessionId: 'private-phase4-session',
        restecPaymentSessionReference: sessionId,
        status: providerStatus,
        amountMinor: 5_000,
        currency: 'PKR',
        expiresAt: '2026-08-06T23:59:00.000Z',
        paidAt: providerStatus === 'paid' ? '2026-08-07T00:05:00.000Z' : null,
      };
    },
    async getBill() {
      return providerStatus === 'paid'
        ? {
            ...bill,
            amount_paid: 5_000,
            amount_due: 5_000,
            payment_status: 'partially_paid',
            updated_at: '2026-08-07T00:05:00.000Z',
          }
        : bill;
    },
  };
  return {
    repo,
    bill,
    service: new ReconciliationService(repo, privateClient as any),
    setProviderStatus(value: typeof providerStatus) {
      providerStatus = value;
    },
  };
}

test('local expires_at never releases capacity without provider terminal proof', async () => {
  const { repo, service } = fixture();
  const result = await service.reconcilePaymentSessions();
  assert.equal(result.expiry_pending_confirmation, 1);
  assert.equal(repo.paymentSessions.get(sessionId)?.status, 'requires_customer_action');
  assert.equal(
    repo.financialReservations.get(`con_phase4:payment_session:${sessionId}`)?.state,
    'reserved',
  );
  assert.equal(repo.outbox.size, 0);
});

test('provider-confirmed expiry releases once, emits once, and allows a new digital session', async () => {
  const { repo, service, setProviderStatus } = fixture();
  setProviderStatus('expired');
  const first = await service.reconcilePaymentSessions();
  const second = await service.reconcilePaymentSessions();
  assert.equal(first.expired, 1);
  assert.equal(second.examined, 0);
  assert.equal(repo.paymentSessions.get(sessionId)?.status, 'expired');
  assert.equal(
    repo.financialReservations.get(`con_phase4:payment_session:${sessionId}`)?.state,
    'expired_released',
  );
  assert.equal(repo.outbox.size, 1);
  await repo.reserveBillCapacity({
    connectionId: 'con_phase4',
    externalBillId: 'BILL-PHASE4',
    reservationIdentity: 'payment_session:rps_test_phase4replacement',
    channel: 'digital_session',
    amountMinor: 5_000,
    currency: 'PKR',
    requestHash: sha256('replacement'),
  });
});

for (const terminal of ['failed', 'cancelled', 'expired'] as const) {
  test(`provider-confirmed ${terminal} releases capacity and late paid safely reacquires it`, async () => {
    const { repo, service, setProviderStatus } = fixture();
    setProviderStatus(terminal);
    await service.reconcilePaymentSessions();
    assert.equal(repo.paymentSessions.get(sessionId)?.status, terminal);
    assert.equal(repo.outbox.size, 1);
    setProviderStatus('paid');
    await repo.transitionPaymentSession(sessionId, terminal, '2026-08-07T00:04:00.000Z');
    const activeTerminal = repo.paymentSessions.get(sessionId)!;
    repo.paymentSessions.set(sessionId, {
      ...activeTerminal,
      status: terminal,
    });
    // Reconciliation normally scans active sessions; explicitly requeueing a known late-success
    // candidate models the persisted reconciliation monitor after a terminal release.
    const originalList = repo.listPaymentSessionsForReconciliation.bind(repo);
    repo.listPaymentSessionsForReconciliation = async () => [repo.paymentSessions.get(sessionId)!];
    await service.reconcilePaymentSessions();
    repo.listPaymentSessionsForReconciliation = originalList;
    assert.equal(repo.paymentSessions.get(sessionId)?.status, 'paid');
    assert.equal(
      repo.financialReservations.get(`con_phase4:payment_session:${sessionId}`)?.state,
      'completed',
    );
    assert.equal(repo.outbox.size, 2);
    assert.equal(repo.bills.get('con_phase4:BILL-PHASE4')?.amount_due, 5_000);
  });
}

test('different technical events for one logical terminal state reuse one POS event', async () => {
  const { repo, service, setProviderStatus } = fixture();
  setProviderStatus('expired');
  await service.reconcilePaymentSessions();
  const session = repo.paymentSessions.get(sessionId)!;
  const firstEvent = [...repo.outbox.values()][0]!;
  const duplicate = await repo.acceptPaymentSessionEvent({
    privateEventId: 'different-provider-event-id',
    eventType: 'payment.expired',
    schemaVersion: '2026-07-01',
    connectionId: session.connectionId,
    requestHash: 'different-event-hash',
    payload: {
      data: {
        connection_id: session.privateConnectionReference,
        location_id: session.privateLocationReference,
        external_bill_id: session.externalBillId,
        payment: {
          amount: session.amountMinor,
          currency: session.currency,
          method: session.method,
        },
        payment_session: {
          private_payment_session_id: session.privatePaymentSessionReference,
          status: 'expired',
        },
      },
    },
    publicEventId: 'evt_differenttechnicalevent',
    publicPayload: firstEvent.payload,
    publicPaymentSessionId: sessionId,
    requestedStatus: 'expired',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.eventId, firstEvent.publicEventId);
  assert.equal(repo.outbox.size, 1);
});

test('expiry versus paid race always finishes paid without reopening or overpaying capacity', async () => {
  for (const order of [
    ['paid', 'expired'],
    ['expired', 'paid'],
  ] as const) {
    const { repo, bill } = fixture();
    const service = (status: 'paid' | 'expired') =>
      new ReconciliationService(repo, {
        async getPaymentSession() {
          return {
            privatePaymentSessionId: 'private-phase4-session',
            restecPaymentSessionReference: sessionId,
            status,
            amountMinor: 5_000,
            currency: 'PKR',
            expiresAt: '2026-08-06T23:59:00.000Z',
            paidAt: status === 'paid' ? '2026-08-07T00:05:00.000Z' : null,
          };
        },
        async getBill() {
          return {
            ...bill,
            amount_paid: 5_000,
            amount_due: 5_000,
            payment_status: 'partially_paid',
          };
        },
      } as any);
    await Promise.all(order.map((status) => service(status).reconcilePaymentSessions()));
    assert.equal(repo.paymentSessions.get(sessionId)?.status, 'paid');
    assert.equal(
      repo.financialReservations.get(`con_phase4:payment_session:${sessionId}`)?.state,
      'completed',
    );
    assert.equal(repo.bills.get('con_phase4:BILL-PHASE4')?.amount_due, 5_000);
    assert.equal(
      [...repo.outbox.values()].filter((event) => event.eventType === 'payment.completed').length,
      1,
    );
  }
});

test('cash, terminal, digital, and three-way mixed reservations share one exact balance', async () => {
  const combinations = [
    [
      ['cash', 4_000, 'external_payment'],
      ['cash', 6_000, 'external_payment'],
    ],
    [
      ['cash', 3_000, 'external_payment'],
      ['terminal', 7_000, 'external_payment'],
    ],
    [
      ['cash', 2_000, 'external_payment'],
      ['digital', 8_000, 'digital_session'],
    ],
    [
      ['terminal', 4_000, 'external_payment'],
      ['digital', 6_000, 'digital_session'],
    ],
    [
      ['cash', 2_000, 'external_payment'],
      ['digital', 4_000, 'digital_session'],
      ['terminal', 4_000, 'external_payment'],
    ],
  ] as const;
  for (const combination of combinations) {
    const { repo } = fixture();
    repo.paymentSessions.clear();
    repo.financialReservations.clear();
    let available = 10_000;
    for (const [index, [identity, amountMinor, channel]] of combination.entries()) {
      const result = await repo.reserveBillCapacity({
        connectionId: 'con_phase4',
        externalBillId: 'BILL-PHASE4',
        reservationIdentity: `${channel}:${identity}:${index}`,
        channel,
        amountMinor,
        currency: 'PKR',
        requestHash: sha256(`${identity}:${amountMinor}:${index}`),
      });
      available -= amountMinor;
      assert.equal(result.projection.availableMinor, available);
    }
    assert.equal(available, 0);
    await assert.rejects(
      repo.reserveBillCapacity({
        connectionId: 'con_phase4',
        externalBillId: 'BILL-PHASE4',
        reservationIdentity: 'external_payment:overpay',
        channel: 'external_payment',
        amountMinor: 1,
        currency: 'PKR',
        requestHash: sha256('overpay'),
      }),
      /payment_capacity_conflict/,
    );
  }
});

test('Phase 4 migration preserves atomic terminal dedupe and capacity checks', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260807000300_normal_payment_lifecycle.sql'),
    'utf8',
  );
  assert.match(migration, /for update/);
  assert.match(migration, /v_session\.status=p_requested_status/);
  assert.match(migration, /payload->'data'->>'payment_session_id'/);
  assert.match(migration, /financial_projection_locked/);
  assert.match(migration, /expired_released/);
});
