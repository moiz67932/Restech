import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const apiKey = process.env.RESTEC_API_KEY!;
const requestSecret = process.env.RESTEC_REQUEST_SIGNING_SECRET!;
const webhookSecret = process.env.RESTEC_WEBHOOK_SIGNING_SECRET!;
const path = '/v1/locations/loc_example/bills/INV-1001';
const body = JSON.stringify({
  external_table_id: '12',
  version: 1,
  currency: 'PKR',
  status: 'open',
  order_status: 'accepted',
  items: [
    { external_item_id: 'I1', name: 'Meal', quantity: 1, unit_amount: 10000, total_amount: 10000 },
  ],
  totals: { subtotal: 10000, tax: 0, service_charge: 0, discount: 0, tip: 0, grand_total: 10000 },
  occurred_at: '2026-07-18T10:30:00Z',
  metadata: {},
});
const timestamp = Math.floor(Date.now() / 1000);
const hex = (value: string, secret: string) =>
  createHmac('sha256', secret).update(value).digest('hex');
const response = await fetch(`https://sandbox-api.restec.io${path}`, {
  method: 'PUT',
  body,
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Restec-Timestamp': String(timestamp),
    'X-Restec-Signature': `v1=${hex(`${timestamp}.PUT.${path}.${body}`, requestSecret)}`,
    'X-Request-Id': `req_${randomUUID().replaceAll('-', '')}`,
    'Idempotency-Key': 'bill-INV-1001-v1',
  },
});
if (!response.ok) throw new Error(`Restec ${response.status}: ${await response.text()}`);

const acceptedEventIds = new Set<string>(); // Replace with a database unique constraint.
createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const eventId = String(req.headers['x-restec-event-id'] ?? ''); // X-Restec-Event-Id
    const ts = Number(req.headers['x-restec-timestamp']);
    const supplied = Buffer.from(
      String(req.headers['x-restec-signature'] ?? '').replace(/^v1=/, ''),
      'hex',
    );
    const expected = Buffer.from(hex(`${ts}.${raw.toString('utf8')}`, webhookSecret), 'hex');
    if (
      Math.abs(Date.now() / 1000 - ts) > 300 ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.writeHead(401).end();
      return;
    }
    if (!acceptedEventIds.has(eventId)) {
      acceptedEventIds.add(eventId); /* transactionally update invoice */
    }
    res.writeHead(202).end();
  });
}).listen(8443); // Terminate HTTPS before this listener in production.
