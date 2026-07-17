import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PaelyClient } from './index.js';
import { verifyRequestSignature } from '@restec/security';
test('mock private server verifies exact signature and idempotency', async () => {
  let seen = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const timestamp = Number(req.headers['x-restec-timestamp']);
    assert(
      verifyRequestSignature({
        secret: 'mock-signing-secret',
        signature: String(req.headers['x-restec-signature']),
        timestamp,
        method: req.method!,
        path: req.url!,
        rawBody: raw,
      }),
    );
    assert.equal(req.headers['idempotency-key'], 'stable-private-key');
    assert.match(String(req.headers['x-request-id']), /^req_/);
    seen = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
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
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock server failed');
  const client = new PaelyClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    bearerToken: 'mock-bearer-token',
    serviceId: 'mock-service',
    environment: 'sandbox',
    signingSecret: 'mock-signing-secret',
    timeoutMs: 1000,
  });
  await client.upsertBill(
    '00000000-0000-0000-0000-000000000001',
    'B1',
    {
      external_table_id: 'T1',
      version: 1,
      currency: 'PKR',
      status: 'open',
      order_status: 'accepted',
      items: [
        { external_item_id: 'I1', name: 'Meal', quantity: 1, unit_amount: 100, total_amount: 100 },
      ],
      totals: { subtotal: 100, tax: 0, service_charge: 0, discount: 0, tip: 0, grand_total: 100 },
      occurred_at: '2026-07-17T00:00:00Z',
      metadata: {},
    },
    'stable-private-key',
  );
  server.close();
  await once(server, 'close');
  assert(seen);
});
