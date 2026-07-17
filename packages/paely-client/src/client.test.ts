import assert from 'node:assert/strict';
import test from 'node:test';
import { PaelyClient } from './index.js';
import { verifyRequestSignature } from '@restec/security';
test('private client signs exact body, preserves idempotency key, rotates request IDs, and removes private IDs', async () => {
  const requests: Request[] = [];
  let count = 0;
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    count++;
    if (count === 1) return new Response('{}', { status: 503 });
    return new Response(
      JSON.stringify({
        integration_bill_id: 'int_bill_private',
        paely_order_id: '00000000-0000-0000-0000-000000000000',
        external_bill_id: 'B1',
        external_table_id: 'T1',
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
        updated_at: '2026-07-17T00:00:00Z',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const client = new PaelyClient({
    baseUrl: 'https://private.example',
    bearerToken: 'token',
    serviceId: 'service',
    environment: 'sandbox',
    signingSecret: 'secret',
    timeoutMs: 1000,
    fetch: fetcher,
  });
  const body = {
    external_table_id: 'T1',
    version: 1,
    currency: 'PKR',
    status: 'open' as const,
    order_status: 'accepted' as const,
    items: [
      { external_item_id: 'I1', name: 'Meal', quantity: 1, unit_amount: 100, total_amount: 100 },
    ],
    totals: { subtotal: 100, tax: 0, service_charge: 0, discount: 0, tip: 0, grand_total: 100 },
    occurred_at: '2026-07-17T00:00:00Z',
    metadata: {},
  };
  const result = await client.upsertBill(
    '00000000-0000-0000-0000-000000000001',
    'B1',
    body,
    'stable-key',
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.headers.get('Idempotency-Key'), 'stable-key');
  assert.equal(requests[1]!.headers.get('Idempotency-Key'), 'stable-key');
  assert.notEqual(
    requests[0]!.headers.get('X-Request-Id'),
    requests[1]!.headers.get('X-Request-Id'),
  );
  const raw = JSON.stringify(body);
  const first = requests[0]!;
  assert(
    verifyRequestSignature({
      secret: 'secret',
      signature: first.headers.get('X-Restec-Signature')!,
      timestamp: Number(first.headers.get('X-Restec-Timestamp')),
      method: 'PUT',
      path: new URL(first.url).pathname,
      rawBody: raw,
    }),
  );
  assert(!('integration_bill_id' in result));
  assert(!('paely_order_id' in result));
});
