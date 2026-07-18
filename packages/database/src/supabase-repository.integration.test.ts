import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
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
