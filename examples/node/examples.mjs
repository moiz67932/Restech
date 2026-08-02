import assert from 'node:assert/strict';
import {
  RestecClient,
  RestecProblem,
  acceptWebhook,
  safelyRetry,
  signWebhook,
  verifyWebhook,
} from './restec-client.mjs';

export const billV1 = {
  external_table_id: 'TABLE-12',
  external_order_id: 'ORDER-1001',
  version: 1,
  currency: 'PKR',
  status: 'open',
  order_status: 'accepted',
  items: [
    {
      external_item_id: 'ITEM-1',
      name: 'Lunch',
      quantity: 1,
      unit_amount: 10000,
      total_amount: 10000,
      notes: 'No onions',
    },
  ],
  totals: {
    subtotal: 10000,
    tax: 0,
    service_charge: 0,
    discount: 0,
    tip: 0,
    grand_total: 10000,
  },
  occurred_at: '2026-08-02T10:00:00Z',
  metadata: {},
};

export async function integrationExamples() {
  const client = new RestecClient({
    baseUrl: process.env.RESTEC_BASE_URL,
    apiCredential: process.env.RESTEC_API_CREDENTIAL,
    requestSigningSecret: process.env.RESTEC_REQUEST_SIGNING_SECRET,
    environment: 'sandbox',
  });
  const locationId = process.env.RESTEC_LOCATION_ID;
  const externalBillId = 'BILL-1001';

  await client.upsertBill(locationId, externalBillId, billV1, 'bill-BILL-1001-v1');
  await safelyRetry(() =>
    client.upsertBill(
      locationId,
      externalBillId,
      { ...billV1, version: 2, occurred_at: '2026-08-02T10:01:00Z' },
      'bill-BILL-1001-v2',
    ),
  );

  const session = await client.createPaymentSession(
    locationId,
    externalBillId,
    { amount_minor: 10000, currency: 'PKR', method: 'card' },
    'session-BILL-1001-1',
  );
  await client.getPaymentSession(locationId, session.payment_session_id);

  const cashBillId = 'BILL-CASH-1001';
  await client.upsertBill(
    locationId,
    cashBillId,
    { ...billV1, external_order_id: 'ORDER-CASH-1001' },
    'bill-BILL-CASH-1001-v1',
  );
  await client.recordPayment(
    locationId,
    cashBillId,
    {
      external_payment_id: 'CASH-1001',
      method: 'cash',
      amount: 10000,
      currency: 'PKR',
      status: 'completed',
      occurred_at: '2026-08-02T10:05:00Z',
      metadata: {},
    },
    'payment-CASH-1001',
  );

  const terminalBillId = 'BILL-TERMINAL-1002';
  await client.upsertBill(
    locationId,
    terminalBillId,
    { ...billV1, external_order_id: 'ORDER-TERMINAL-1002' },
    'bill-BILL-TERMINAL-1002-v1',
  );
  await client.recordPayment(
    locationId,
    terminalBillId,
    {
      external_payment_id: 'TERMINAL-1002',
      method: 'card_terminal',
      amount: 10000,
      currency: 'PKR',
      status: 'completed',
      occurred_at: '2026-08-02T10:06:00Z',
      processor_reference: 'TERMINAL-APPROVAL-1002',
      metadata: {},
    },
    'payment-TERMINAL-1002',
  );

  await safelyRetry(() => client.getBill(locationId, externalBillId));
}

export function handleProblem(error) {
  if (!(error instanceof RestecProblem)) throw error;
  if (error.status === 409) return { action: 'reconcile', request_id: error.requestId };
  if (error.status === 422)
    return { action: 'correct_fields', fields: error.fieldErrors, request_id: error.requestId };
  if (error.status === 429)
    return { action: 'retry_after', seconds: error.retryAfterSeconds, request_id: error.requestId };
  throw error;
}

async function selfTest() {
  const secret = 'example-webhook-secret-not-for-production';
  const timestamp = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({
    event_id: 'evt_example1001',
    event_type: 'payment.completed',
    event_version: '1.0',
    occurred_at: new Date(timestamp * 1000).toISOString(),
    environment: 'sandbox',
    partner_id: 'ptr_example',
    location_id: 'loc_example',
    external_bill_id: 'BILL-1001',
    payment_reference: 'pay_example1001',
    amount_minor: 10000,
    currency: 'PKR',
    payment_method: 'cash',
    payment_status: 'completed',
    bill: {
      grand_total: 10000,
      amount_paid: 10000,
      amount_refunded: 0,
      amount_due: 0,
      payment_status: 'paid',
      version: 2,
    },
    metadata: {},
  });
  const headers = {
    'x-restec-event-id': 'evt_example1001',
    'x-restec-timestamp': String(timestamp),
    'x-restec-environment': 'sandbox',
    'x-restec-signature': signWebhook(secret, timestamp, rawBody),
  };
  assert.equal(verifyWebhook({ secret, rawBody, headers }), true);
  const values = new Map();
  let applied = 0;
  const eventStore = {
    async insertUnique(id, body) {
      if (!values.has(id)) {
        values.set(id, body);
        return 'inserted';
      }
      return values.get(id) === body ? 'duplicate' : 'conflict';
    },
  };
  const applyEvent = async () => applied++;
  assert.equal(
    (await acceptWebhook({ secret, rawBody, headers, eventStore, applyEvent })).status,
    204,
  );
  assert.equal(
    (await acceptWebhook({ secret, rawBody, headers, eventStore, applyEvent })).status,
    204,
  );
  assert.equal(applied, 1);
  console.log('Restec Node.js examples self-test passed.');
}

if (process.argv.includes('--self-test')) await selfTest();
