import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { verifyEventSignature } from '@restec/security';
import { canonicalRestConnector } from './index.js';

test('mock POS server verifies signed events and exposes retry/permanent responses', async () => {
  let status = 202;
  let accepted = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const timestamp = Number(req.headers['x-restec-timestamp']);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/integrations/restec/webhooks');
    assert.equal(req.headers['x-restec-event-id'], 'evt_mockpos1');
    assert.equal(req.headers['x-restec-delivery-attempt'], '1');
    assert(
      verifyEventSignature({
        secret: 'webhook-secret',
        signature: String(req.headers['x-restec-signature']),
        timestamp,
        rawBody: raw,
      }),
    );
    assert.equal(JSON.parse(raw.toString('utf8')).schema_version, '2026-07-01');
    accepted++;
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end('response body must not be persisted');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock POS server failed');
  const configuration = {
    webhook_url: `http://127.0.0.1:${address.port}/integrations/restec/webhooks`,
    webhook_secret: 'webhook-secret',
  };
  const context = {
    partnerId: 'ptr_test',
    connectionId: 'con_test',
    locationId: 'loc_test',
    environment: 'test' as const,
    configuration,
  };
  const payload = await canonicalRestConnector.serializeEvent(
    {
      id: 'evt_mockpos1',
      type: 'payment.completed',
      schema_version: '2026-07-01',
      created_at: '2026-07-18T10:50:00Z',
      data: {
        location_id: 'loc_test',
        external_bill_id: 'INV-1',
        external_table_id: '12',
        payment: {
          restec_payment_id: 'pay_mock1',
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
    },
    context,
  );
  const deliveryContext = { ...context, eventId: 'evt_mockpos1', attempt: 1, timeoutMs: 1000 };
  assert.equal(
    (await canonicalRestConnector.deliverEvent(payload, deliveryContext)).outcome,
    'delivered',
  );
  status = 429;
  assert.equal(
    (await canonicalRestConnector.deliverEvent(payload, deliveryContext)).outcome,
    'retry',
  );
  status = 400;
  assert.equal(
    (await canonicalRestConnector.deliverEvent(payload, deliveryContext)).outcome,
    'permanent_failure',
  );
  server.close();
  await once(server, 'close');
  assert.equal(accepted, 3);
});
