const topics = [
  [
    'Introduction',
    'Restec is an alternate digital payment integration interface for restaurant POS systems. Synchronize bills, report completed external payments, receive signed payment events, and reconcile after downtime.',
  ],
  [
    'Architecture from POS perspective',
    'The POS communicates only with the Restec public API and one signed Restec webhook. The physical table QR stays stable; send the correct external_table_id for every bill.',
  ],
  [
    'Quick Start',
    'Obtain sandbox credentials, list tables, create a version-1 bill, register an HTTPS webhook, run payment.completed, verify and deduplicate the event, then retrieve the bill.',
  ],
  [
    'Authentication',
    'Send Bearer rst_test_... in sandbox or rst_live_... in production. Credentials are isolated, revocable, rotatable, and full keys are displayed once.',
  ],
  [
    'Request Signing',
    'HMAC-SHA256 lowercase hex over timestamp.METHOD.path.exact_raw_body. Send X-Restec-Timestamp, X-Restec-Signature, and a fresh X-Request-Id.',
  ],
  [
    'Idempotency',
    'Every mutation needs a stable Idempotency-Key. Exact replay returns the original response; reuse with different input returns a conflict.',
  ],
  [
    'Sandbox and Production',
    'Sandbox is https://sandbox-api.restec.io. Production is https://api.restec.io. The scenario route returns 404 in production.',
  ],
  [
    'Create or Update Bill',
    'PUT /v1/locations/{locationId}/bills/{externalBillId}. New bills start at version 1. Use integer minor units and reconcile every item and total exactly.',
  ],
  [
    'Retrieve Bill',
    'GET the bill path for canonical payment state after downtime or an ambiguous request. GET has an empty signed body and no idempotency key.',
  ],
  [
    'External POS Payments',
    'Report completed cash, card terminal, wallet terminal, voucher, or other payments. Never send card numbers, CVV, PIN, track, or raw wallet credentials.',
  ],
  [
    'Hosted Payment Sessions',
    'Create a card payment session for an open bill, open only the returned Restec checkout URL, then wait for a verified Restec payment.completed webhook or query the signed status endpoint. The initial state requires customer action.',
  ],
  [
    'Tables',
    'GET /v1/locations/{locationId}/tables and use its external_table_id in bill requests. Only active authorized mappings are accepted.',
  ],
  [
    'Payment Webhooks',
    'Events are payment.completed, payment.failed, payment.expired, payment.refunded, and payment.partially_refunded. Hosted-payment events include a Restec payment_session_id.',
  ],
  [
    'Webhook Verification',
    'Verify timestamp.exact_raw_body with the webhook secret before parsing. Store the event ID uniquely and apply the invoice update once before returning 2xx.',
  ],
  [
    'Payment Statuses',
    'Close the invoice only when payment_status is paid and amount_due is zero. A hosted checkout redirect or return page is never proof of payment.',
  ],
  [
    'Retries',
    'Temporary delivery failures retry after 30s, 2m, 10m, 30m, 2h, 6h, and 12h with the same event ID. Permanent failures become visible for review.',
  ],
  [
    'Error Codes',
    'Errors use a stable code, safe message, request ID, and details. Quote the request ID to support; never include secrets in a ticket.',
  ],
  [
    'Sandbox Scenarios',
    'Exercise success, failure, refund, partial, duplicate, delay, ordering, timeout, 429, 500, mismatch, and already-paid behavior through the normal pipeline.',
  ],
  [
    'Certification',
    'Prove signature rejection, versioning, duplicate safety, external payments, partial/full state, webhook durability, retries, dead-letter visibility, and credential isolation.',
  ],
  [
    'API Changelog',
    'Current HTTP version: v1. Current event schema: 2026-07-01. Compatible fields may be added; breaking changes receive a new version and migration window.',
  ],
  [
    'Support',
    'Send environment, request or event ID, UTC time, endpoint, status, and a redacted summary. Never send full API keys or signing secrets.',
  ],
] as const;

const slug = (value: string) => value.toLowerCase().replaceAll(' ', '-');
export default function Docs() {
  return (
    <main
      style={{
        maxWidth: 1100,
        margin: '0 auto',
        padding: 32,
        fontFamily: 'system-ui',
        lineHeight: 1.55,
      }}
    >
      <header>
        <strong>Restec Developers</strong>
        <p>Sandbox · Production</p>
        <h1>One contract for restaurant POS payments</h1>
        <p>Public API, signed events, reliable retries, and reconciliation.</p>
      </header>
      <nav
        aria-label="Documentation sections"
        style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}
      >
        {topics.map(([title]) => (
          <a key={title} href={`#${slug(title)}`}>
            {title}
          </a>
        ))}
      </nav>
      <section>
        <h2>Signed bill request</h2>
        <pre style={{ overflowX: 'auto', padding: 16, background: '#f3f5f4' }}>
          <code>{`curl -X PUT https://sandbox-api.restec.io/v1/locations/loc_example/bills/INV-1001 \\\n  -H "Authorization: Bearer rst_test_replace" \\\n  -H "Content-Type: application/json" \\\n  -H "X-Restec-Timestamp: <unix-seconds>" \\\n  -H "X-Restec-Signature: v1=<hmac>" \\\n  -H "X-Request-Id: req_<unique>" \\\n  -H "Idempotency-Key: bill-INV-1001-v1" \\\n  --data-binary @bill.json`}</code>
        </pre>
      </section>
      {topics.map(([title, text]) => (
        <section id={slug(title)} key={title}>
          <h2>{title}</h2>
          <p>{text}</p>
        </section>
      ))}
      <footer>
        <p>
          See the Restec POS API reference, integration guide, language samples, sandbox collection,
          and certification checklist.
        </p>
      </footer>
    </main>
  );
}
