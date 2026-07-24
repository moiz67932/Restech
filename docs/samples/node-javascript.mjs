import { createHmac, randomUUID } from 'node:crypto';
import console from 'node:console';
import process from 'node:process';

const path = '/v1/locations/loc_example/bills/INV-1001/payment-sessions';
const body = JSON.stringify({ amount_minor: 10000, currency: 'PKR', method: 'card' });
const timestamp = Math.floor(Date.now() / 1000);
const signature = createHmac('sha256', process.env.RESTEC_REQUEST_SIGNING_SECRET)
  .update(`${timestamp}.POST.${path}.${body}`)
  .digest('hex');
const response = await globalThis.fetch(`https://sandbox-api.restec.io${path}`, {
  method: 'POST',
  body,
  headers: {
    Authorization: `Bearer ${process.env.RESTEC_API_KEY}`,
    'Content-Type': 'application/json',
    'X-Restec-Environment': 'sandbox',
    'X-Restec-Timestamp': String(timestamp),
    'X-Restec-Signature': `v1=${signature}`,
    'X-Request-Id': `req_${randomUUID().replaceAll('-', '')}`,
    'Idempotency-Key': 'hosted-payment-INV-1001-1',
  },
});
if (!response.ok) throw new Error(`Restec payment session ${response.status}`);
const session = await response.json();
console.log(session.checkout_url); // Open for the customer. Wait for X-Restec-Event-Id webhook.
