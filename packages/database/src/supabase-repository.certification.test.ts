import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

const configured = Boolean(process.env.RUN_DATABASE_INTEGRATION === 'true' && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.RESTEC_CERTIFICATION_CONNECTION_ID);
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for database certification`);
  return value;
};
const clients = () => [0, 1].map(() => createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } }));
const createBill = async (billId: string) => {
  const db = clients()[0]!;
  const result = await db.rpc('persist_restec_bill_state', {
    p_connection_id: required('RESTEC_CERTIFICATION_CONNECTION_ID'),
    p_external_bill_id: billId,
    p_public_bill_id: `bil_${billId.slice(-20)}`,
    p_private_reference: `cert_${billId}`,
    p_version: 1,
    p_request_hash: billId,
    p_public_state: {
      request_id: `req_${billId}`,
      restec_bill_id: `bil_${billId.slice(-20)}`,
      external_bill_id: billId,
      external_table_id: 'EXT-01',
      sync_status: 'accepted',
      order_status: 'accepted',
      payment_status: 'unpaid',
      table_session_status: 'dining',
      currency: process.env.RESTEC_CERTIFICATION_CURRENCY ?? 'PKR',
      grand_total: 10000,
      amount_paid: 0,
      amount_refunded: 0,
      amount_due: 10000,
      version: 1,
      reconciliation_status: 'matched',
      updated_at: new Date().toISOString(),
    },
  });
  if (result.error) throw new Error(`fixture bill creation failed: ${result.error.code ?? 'unknown'}`);
};
const race = async (billId: string, amount: number, expectedWinners: number, label: string) => {
  const prefix = `restec_cert_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dbs = clients();
  const results = await Promise.all(Array.from({ length: 100 }, (_, index) => dbs[index % 2]!.rpc('reserve_bill_capacity', {
    p_connection_id: required('RESTEC_CERTIFICATION_CONNECTION_ID'),
    p_external_bill_id: billId,
    p_reservation_identity: `${prefix}_${index}`,
    p_channel: 'external_payment',
    p_amount_minor: amount,
    p_currency: process.env.RESTEC_CERTIFICATION_CURRENCY ?? 'PKR',
    p_request_hash: `${prefix}_${index}`,
    p_expires_at: null,
  })));
  assert.equal(results.filter((result) => !result.error).length, expectedWinners, `${label}: capacity winners mismatch`);
};
test('100 independent-connection full-balance requests have one winner', { skip: !configured }, async () => {
  const billId = `RESTEC-CERT-FULL-${Date.now()}`;
  await createBill(billId);
  await race(billId, 10000, 1, 'full');
});
test('100 independent-connection partial requests stay within capacity', { skip: !configured }, async () => {
  const billId = `RESTEC-CERT-PARTIAL-${Date.now()}`;
  await createBill(billId);
  await race(billId, 2500, 4, 'partial');
});
