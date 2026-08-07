import { createClient } from '@supabase/supabase-js';

const env = process.env;
const fail = (message: string): never => {
  console.error(`DATABASE_CONSISTENCY_AUDIT_FAILED: ${message}`);
  process.exit(2);
};
if (env.RESTEC_DATABASE_CERTIFICATION !== 'true') fail('RESTEC_DATABASE_CERTIFICATION=true is required.');
if (!['test', 'sandbox'].includes(env.RESTEC_ENV ?? '')) fail('production audit execution is forbidden.');
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) fail('database credentials are required.');
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const read = async (table: string, columns: string) => {
  const result = await db.from(table).select(columns);
  if (result.error) fail(`${table} read failed (${result.error.code ?? 'unknown'}).`);
  return result.data ?? [];
};
const [reservations, bills, payments, sessions, outbox] = await Promise.all([
  read('financial_reservations', 'id,bill_mapping_id,reservation_identity,channel,amount_minor,state'),
  read('bill_mappings', 'id,public_state'),
  read('external_payments', 'bill_mapping_id,external_payment_id'),
  read('payment_sessions', 'public_payment_session_id,status'),
  read('pos_outbox_events', 'public_event_id,deduplication_key'),
]);
const billIds = new Set(bills.map((bill: any) => bill.id));
const paymentIds = new Set(payments.map((payment: any) => payment.external_payment_id));
const sessionIds = new Set(sessions.map((session: any) => session.public_payment_session_id));
const identities = new Set<string>();
const outboxKeys = new Set<string>();
const problems: string[] = [];
for (const reservation of reservations as any[]) {
  const identity = `${reservation.bill_mapping_id}:${reservation.reservation_identity}`;
  if (identities.has(identity)) problems.push('duplicate reservation identity');
  identities.add(identity);
  if (!billIds.has(reservation.bill_mapping_id)) problems.push('reservation without bill projection');
  if (reservation.state === 'completed') {
    const [, evidenceId] = String(reservation.reservation_identity).split(':');
    const exists = reservation.channel === 'external_payment' ? paymentIds.has(evidenceId) : sessionIds.has(evidenceId);
    if (!exists) problems.push('completed reservation without immutable evidence');
  }
}
for (const event of outbox as any[]) {
  if (outboxKeys.has(String(event.deduplication_key))) problems.push('duplicate POS outbox logical key');
  outboxKeys.add(String(event.deduplication_key));
}
for (const bill of bills as any[]) {
  const state = bill.public_state ?? {};
  if (Number(state.amount_due ?? 0) < 0) problems.push('negative amount_due');
  if (Number(state.amount_paid ?? 0) > Number(state.grand_total ?? 0) && Number(state.amount_refunded ?? 0) === 0)
    problems.push('paid amount exceeds bill total without refund evidence');
}
console.log(JSON.stringify({ read_only: true, environment: env.RESTEC_ENV, counts: { reservations: reservations.length, bills: bills.length, payments: payments.length, sessions: sessions.length, outbox: outbox.length }, problems }));
if (problems.length) process.exit(1);
