import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { signRequest } from '@restec/security';

if (process.env.RUN_REAL_PAYMENT_SESSION_CERTIFICATION !== 'true')
  throw new Error(
    'Refusing remote calls. Set RUN_REAL_PAYMENT_SESSION_CERTIFICATION=true explicitly.',
  );
if (process.env.RESTEC_ENV !== 'sandbox')
  throw new Error('Real payment-session certification is sandbox-only.');

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};
const baseUrl = new URL(required('RESTEC_PUBLIC_BASE_URL'));
if (baseUrl.protocol !== 'https:') throw new Error('The sandbox API base URL must use HTTPS.');
const apiKey = required('RESTEC_SANDBOX_TEST_API_KEY');
const signingSecret = required('RESTEC_SANDBOX_REQUEST_SIGNING_SECRET');
const locationId = required('RESTEC_SANDBOX_LOCATION_ID');
const jobToken = required('RESTEC_INTERNAL_JOB_TOKEN');
const verifyOnly = process.argv.includes('--verify');
const timeoutMs = Number(process.env.RESTEC_CERTIFICATION_TIMEOUT_SECONDS ?? 900) * 1000;

const failure = async (name: string, response: Response): Promise<never> => {
  let code = 'unknown_error';
  try {
    const body = (await response.json()) as { error?: { code?: string; request_id?: string } };
    code = [body.error?.code, body.error?.request_id].filter(Boolean).join(':');
  } catch {
    // Keep remote response bodies out of certification output.
  }
  throw new Error(`${name} failed with HTTP ${response.status} (${code}).`);
};

async function signedRequest(
  method: 'PUT' | 'POST' | 'GET',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Restec-Environment': 'sandbox',
    'X-Restec-Timestamp': String(timestamp),
    'X-Restec-Signature': signRequest(signingSecret, timestamp, method, path, raw),
    'X-Request-Id': `req_${randomUUID().replaceAll('-', '')}`,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers,
    ...(body === undefined ? {} : { body: raw }),
  });
  if (!response.ok) await failure(path, response);
  return response;
}

const health = await fetch(new URL('/health', baseUrl));
if (!health.ok) await failure('health', health);
const healthBody = (await health.json()) as { status?: string; environment?: string };
if (healthBody.status !== 'ok' || healthBody.environment !== 'sandbox')
  throw new Error('The deployed Restec API is not reporting sandbox health.');

let externalBillId = process.env.RESTEC_CERTIFICATION_EXTERNAL_BILL_ID ?? '';
let paymentSessionId = process.env.RESTEC_CERTIFICATION_PAYMENT_SESSION_ID ?? '';
let checkoutOrigin = baseUrl.origin;
let initialStatus = 'unknown';

if (!verifyOnly) {
  const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  externalBillId = `CERT-${suffix}`;
  const billPath = `/v1/locations/${encodeURIComponent(locationId)}/bills/${encodeURIComponent(externalBillId)}`;
  await signedRequest(
    'PUT',
    billPath,
    {
      external_table_id: process.env.RESTEC_SANDBOX_EXTERNAL_TABLE_ID ?? 'EXT-01',
      version: 1,
      currency: 'PKR',
      status: 'open',
      order_status: 'accepted',
      items: [
        {
          external_item_id: 'CERT-ITEM-1',
          name: 'Sandbox certification item',
          quantity: 1,
          unit_amount: 10_000,
          total_amount: 10_000,
        },
      ],
      totals: {
        subtotal: 10_000,
        tax: 0,
        service_charge: 0,
        discount: 0,
        tip: 0,
        grand_total: 10_000,
      },
      occurred_at: new Date().toISOString(),
      metadata: { certification: true },
    },
    `cert-bill-${suffix}`,
  );
  const createPath = `${billPath}/payment-sessions`;
  const created = await signedRequest(
    'POST',
    createPath,
    {
      amount_minor: 10_000,
      currency: 'PKR',
      method: 'card',
      customer: { email: 'sandbox@example.com', mobile: '03000000000' },
      return_context: { pos_reference: `cert-${suffix}` },
    },
    `cert-payment-${suffix}`,
  );
  const session = (await created.json()) as {
    payment_session_id: string;
    checkout_url: string;
    status: string;
  };
  if (session.status !== 'requires_customer_action')
    throw new Error('The initial payment session did not require customer action.');
  paymentSessionId = session.payment_session_id;
  initialStatus = session.status;
  const checkout = new URL(session.checkout_url);
  if (checkout.origin !== baseUrl.origin)
    throw new Error('The API did not return a Restec-origin checkout URL.');
  checkoutOrigin = checkout.origin;
  console.log(`Restec checkout URL: ${checkout.toString()}`);
  if (!process.argv.includes('--no-wait')) {
    const prompt = createInterface({ input: stdin, output: stdout });
    await prompt.question(
      'Open that URL and manually complete the sandbox hosted checkout. Press Enter afterward.',
    );
    prompt.close();
  }
} else if (!paymentSessionId) {
  throw new Error('Set RESTEC_CERTIFICATION_PAYMENT_SESSION_ID for --verify mode.');
} else {
  initialStatus = required('RESTEC_CERTIFICATION_INITIAL_STATUS');
  if (initialStatus !== 'requires_customer_action')
    throw new Error('--verify requires preserved evidence of the initial customer-action state.');
}

const statusPath = `/v1/locations/${encodeURIComponent(locationId)}/payment-sessions/${encodeURIComponent(paymentSessionId)}`;
const deadline = Date.now() + timeoutMs;
let finalStatus = 'unknown';
while (Date.now() < deadline) {
  const response = await signedRequest('GET', statusPath);
  const status = (await response.json()) as {
    status: string;
    external_bill_id: string;
  };
  finalStatus = status.status;
  externalBillId ||= status.external_bill_id;
  if (finalStatus === 'paid') break;
  if (['failed', 'expired', 'refunded'].includes(finalStatus))
    throw new Error(`Certification stopped in terminal state ${finalStatus}.`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (finalStatus !== 'paid') throw new Error('Timed out waiting for authoritative paid state.');

const dispatch = await fetch(new URL('/api/internal/jobs/dispatch-pos-events', baseUrl), {
  method: 'POST',
  headers: { Authorization: `Bearer ${jobToken}`, 'Content-Type': 'application/json' },
});
if (!dispatch.ok) await failure('POS event dispatcher', dispatch);

let evidence: any;
while (Date.now() < deadline) {
  const response = await fetch(
    new URL(
      `/api/internal/test/payment-sessions/${encodeURIComponent(paymentSessionId)}/evidence`,
      baseUrl,
    ),
    { headers: { Authorization: `Bearer ${jobToken}` } },
  );
  if (!response.ok) await failure('certification evidence', response);
  evidence = await response.json();
  if (evidence.pos_outbox_status === 'delivered' && evidence.mock_pos_accepted) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

const passed =
  initialStatus === 'requires_customer_action' &&
  finalStatus === 'paid' &&
  evidence?.private_event_accepted === true &&
  evidence?.bill_payment_status === 'paid' &&
  evidence?.pos_outbox_status === 'delivered' &&
  evidence?.mock_pos_accepted === true &&
  evidence?.dead_lettered === false;
console.log(
  JSON.stringify(
    {
      result: passed ? 'PASS' : 'FAIL',
      bill_id: externalBillId,
      payment_session_id: paymentSessionId,
      checkout_origin: checkoutOrigin,
      initial_status: initialStatus,
      final_status: finalStatus,
      private_event_accepted: evidence?.private_event_accepted ?? false,
      bill_projection_paid: evidence?.bill_payment_status === 'paid',
      pos_outbox_delivered: evidence?.pos_outbox_status === 'delivered',
      dummy_pos_accepted: evidence?.mock_pos_accepted ?? false,
      webhook_signature_verified: evidence?.mock_pos_accepted ?? false,
      delivery_attempts: evidence?.delivery_attempts ?? null,
      dead_lettered: evidence?.dead_lettered ?? null,
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;
