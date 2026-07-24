import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { SupabaseRepository } from './supabase-repository.js';
const enabled =
  (process.env.RUN_REMOTE_SANDBOX_TESTS === 'true' ||
    process.env.RUN_DATABASE_INTEGRATION === 'true') &&
  Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
test(
  'database atomically accepts one inbox event and one POS outbox event',
  { skip: !enabled },
  async () => {
    const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });
    const suffix = Date.now().toString(36);
    const privateId = `db_test_${suffix}`,
      publicId = `evt_${suffix}`;
    const externalBillId = `DB-TEST-${suffix}`;
    const payload = {
      id: publicId,
      type: 'payment.completed',
      schema_version: '2026-07-01',
      created_at: new Date().toISOString(),
      data: {
        location_id: 'loc_sandbox_demo',
        external_bill_id: externalBillId,
        external_table_id: 'EXT-01',
        payment: {
          restec_payment_id: `pay_${suffix}`,
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
    };
    const { error: billError } = await db.rpc('persist_restec_bill_state', {
      p_connection_id: 'con_sandbox_canonical',
      p_external_bill_id: externalBillId,
      p_public_bill_id: `bil_${suffix}`,
      p_private_reference: `int_bill_${suffix}`,
      p_version: 1,
      p_request_hash: suffix,
      p_public_state: {
        request_id: `req_${suffix}`,
        restec_bill_id: `bil_${suffix}`,
        external_bill_id: externalBillId,
        external_table_id: 'EXT-01',
        sync_status: 'accepted',
        order_status: 'accepted',
        payment_status: 'unpaid',
        table_session_status: 'dining',
        currency: 'PKR',
        grand_total: 100,
        amount_paid: 0,
        amount_refunded: 0,
        amount_due: 100,
        version: 1,
        reconciliation_status: 'matched',
        updated_at: new Date().toISOString(),
      },
    });
    assert.equal(billError, null);
    const { error } = await db.rpc('accept_private_event', {
      p_private_event_id: privateId,
      p_event_type: 'payment.completed',
      p_schema_version: '2026-07-01',
      p_connection_id: 'con_sandbox_canonical',
      p_request_hash: suffix,
      p_payload: { id: privateId },
      p_public_event_id: publicId,
      p_public_payload: payload,
    });
    assert.equal(error, null);
    const [{ count: inbox }, { count: outbox }] = await Promise.all([
      db
        .from('private_event_inbox')
        .select('*', { count: 'exact', head: true })
        .eq('private_event_id', privateId),
      db
        .from('pos_outbox_events')
        .select('*', { count: 'exact', head: true })
        .eq('public_event_id', publicId),
    ]);
    assert.equal(inbox, 1);
    assert.equal(outbox, 1);
  },
);
test(
  'database payment-session repository applies additive state transitions consistently',
  { skip: !enabled },
  async () => {
    const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });
    const repository = new SupabaseRepository(db, {
      apiKeyHashSecret: 'integration-test-pepper-32-bytes-minimum',
      secretEncryptionKey: Buffer.alloc(32).toString('base64'),
    });
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const publicPaymentSessionId = `rps_test_${suffix}`;
    const input = {
      publicPaymentSessionId,
      environment: 'sandbox' as const,
      partnerId: 'ptr_sandbox_demo',
      connectionId: 'con_sandbox_canonical',
      locationId: 'loc_sandbox_demo',
      externalBillId: `DB-PAYMENT-${suffix}`,
      privateLocationReference: '00000000-0000-4000-8000-000000000101',
      privateConnectionReference: '00000000-0000-4000-8000-000000000201',
      method: 'card' as const,
      amountMinor: 100,
      currency: 'PKR' as const,
      status: 'creating' as const,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      idempotencyKey: `db-payment-${suffix}`,
      requestFingerprint: suffix,
    };
    const first = await repository.reservePaymentSession(input);
    const replay = await repository.reservePaymentSession(input);
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    await repository.attachPaymentSession({
      publicPaymentSessionId,
      privatePaymentSessionReference: `private-${suffix}`,
      encryptedProviderCheckoutUrl: 'ciphertext.placeholder.value',
      providerCheckoutHost: 'checkout.example',
      status: 'requires_customer_action',
      expiresAt: input.expiresAt,
    });
    await repository.transitionPaymentSession(
      publicPaymentSessionId,
      'cancelled',
      new Date().toISOString(),
    );
    const authoritative = await repository.transitionPaymentSession(
      publicPaymentSessionId,
      'paid',
      new Date().toISOString(),
    );
    assert.equal(authoritative.record.status, 'paid');
    assert.equal(
      (await repository.getPaymentSession(publicPaymentSessionId))?.paidAt !== undefined,
      true,
    );
  },
);
