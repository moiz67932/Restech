import { randomUUID } from 'node:crypto';
import { signRequest } from '@restec/security';

if (process.env.RUN_REMOTE_SANDBOX_TESTS !== 'true')
  throw new Error('Refusing remote calls. Set RUN_REMOTE_SANDBOX_TESTS=true explicitly.');
if (process.env.RESTEC_ENV !== 'sandbox') throw new Error('This script is sandbox-only.');
const operation = process.argv[2];
const base = process.env.RESTEC_PUBLIC_BASE_URL;
if (!base?.startsWith('https://')) throw new Error('Set the HTTPS sandbox RESTEC_PUBLIC_BASE_URL.');

if (operation === 'create-bill') {
  const apiKey = process.env.RESTEC_SANDBOX_TEST_API_KEY;
  const secret = process.env.RESTEC_SANDBOX_REQUEST_SIGNING_SECRET;
  const location = process.env.RESTEC_SANDBOX_LOCATION_ID;
  if (!apiKey || !secret || !location) throw new Error('Missing sandbox POS credentials.');
  const externalBillId = process.env.RESTEC_SANDBOX_EXTERNAL_BILL_ID ?? 'INV-DEMO-1001';
  const path = `/v1/locations/${encodeURIComponent(location)}/bills/${encodeURIComponent(externalBillId)}`;
  const body = JSON.stringify({
    external_table_id: process.env.RESTEC_SANDBOX_EXTERNAL_TABLE_ID ?? 'EXT-01',
    version: 1,
    currency: 'PKR',
    status: 'open',
    order_status: 'accepted',
    items: [
      {
        external_item_id: 'ITEM-1',
        name: 'Sandbox meal',
        quantity: 1,
        unit_amount: 10000,
        total_amount: 10000,
      },
    ],
    totals: { subtotal: 10000, tax: 0, service_charge: 0, discount: 0, tip: 0, grand_total: 10000 },
    occurred_at: new Date().toISOString(),
    metadata: {},
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await fetch(new URL(path, base), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Restec-Timestamp': String(timestamp),
      'X-Restec-Signature': signRequest(secret, timestamp, 'PUT', path, body),
      'X-Request-Id': `req_${randomUUID().replaceAll('-', '')}`,
      'Idempotency-Key': `demo:${externalBillId}:v1`,
    },
    body,
  });
  if (!response.ok) throw new Error(`Sandbox bill failed with HTTP ${response.status}.`);
  console.log(await response.text());
} else if (operation === 'dispatch' || operation === 'reconcile') {
  const token = process.env.RESTEC_INTERNAL_JOB_TOKEN;
  if (!token) throw new Error('Missing RESTEC_INTERNAL_JOB_TOKEN.');
  const path =
    operation === 'dispatch'
      ? '/api/internal/jobs/dispatch-pos-events'
      : '/api/internal/jobs/reconcile';
  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (operation === 'reconcile')
    init.body = JSON.stringify({
      partner_id: process.env.RESTEC_SANDBOX_PARTNER_ID,
      location_id: process.env.RESTEC_SANDBOX_LOCATION_ID,
      external_bill_id: process.env.RESTEC_SANDBOX_EXTERNAL_BILL_ID ?? 'INV-DEMO-1001',
      action: 'compare',
    });
  const response = await fetch(new URL(path, base), init);
  if (!response.ok) throw new Error(`Sandbox ${operation} failed with HTTP ${response.status}.`);
  console.log(await response.text());
} else throw new Error('Expected create-bill, dispatch, or reconcile.');
