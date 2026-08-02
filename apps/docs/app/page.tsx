import Link from 'next/link';

const cards = [
  [
    'Bill synchronization',
    'Keep bills, revisions, tables, and totals aligned.',
    '/docs/bill-and-order-sync',
  ],
  [
    'Customer payment sessions',
    'Open a secure hosted payment session and wait for authoritative status.',
    '/docs/customer-payment-sync',
  ],
  [
    'Cash and terminal payments',
    'Report completed POS-originated payment facts safely.',
    '/docs/traditional-payment-sync',
  ],
  [
    'Signed payment webhooks',
    'Verify, deduplicate, and commit one POS update per event.',
    '/docs/webhooks',
  ],
  [
    'Idempotent retries',
    'Retry ambiguous mutations without creating a second financial result.',
    '/docs/idempotency-and-retries',
  ],
  [
    'Multi-location credentials',
    'Use scoped, environment-specific credentials for each location.',
    '/docs/credential-ownership',
  ],
];

export default function Home() {
  return (
    <main>
      <section className="hero shell">
        <div className="eyebrow">RESTEC PARTNER API · VERSION 1</div>
        <h1>Payments that stay in sync with your POS.</h1>
        <p className="lede">
          A clear, signed contract for restaurant bill synchronization, customer payments,
          traditional payments, and reliable webhook delivery.
        </p>
        <div className="actions">
          <Link className="button primary" href="/docs/quickstart">
            Start integration →
          </Link>
          <Link className="button" href="/api-reference">
            Explore API reference
          </Link>
          <Link className="text-button" href="/resources/postman">
            Download Postman
          </Link>
        </div>
        <div className="architecture">
          <div>
            <b>Restaurant POS</b>
            <span>bill + payment facts</span>
          </div>
          <i>↔</i>
          <div className="accent">
            <b>Restec Partner API</b>
            <span>signed requests + events</span>
          </div>
          <i>↔</i>
          <div>
            <b>Restec-managed systems</b>
            <span>authoritative payment state</span>
          </div>
        </div>
      </section>
      <section className="shell section">
        <div className="section-heading">
          <div>
            <div className="eyebrow">THE CONTRACT</div>
            <h2>Everything your integration needs.</h2>
          </div>
          <Link href="/docs">Browse all guides →</Link>
        </div>
        <div className="card-grid">
          {cards.map(([title, text, href]) => (
            <Link className="feature-card" href={href} key={title}>
              <span className="card-mark">+</span>
              <h3>{title}</h3>
              <p>{text}</p>
              <span className="arrow">↗</span>
            </Link>
          ))}
        </div>
      </section>
      <section className="shell callout">
        <div>
          <div className="eyebrow">IMPORTANT · V1 LIMITATION</div>
          <h2>Know what is not supported.</h2>
          <p>
            POS-initiated refund, void, and reversal operations are unavailable in v1. Refund events
            may be delivered as authoritative notifications; the POS cannot initiate them through
            this API.
          </p>
        </div>
        <Link className="button" href="/docs/compatibility">
          Read compatibility policy
        </Link>
      </section>
      <section className="shell split section">
        <div>
          <div className="eyebrow">A FAST START</div>
          <h2>Build your first sandbox request in minutes.</h2>
          <p>
            Get environment credentials, sign the exact request bytes, upsert a bill, and verify the
            resulting webhook with the language example that matches your stack.
          </p>
          <Link href="/docs/quickstart" className="inline-link">
            Read the quickstart →
          </Link>
        </div>
        <div className="code-card">
          <div className="code-label">request.sh</div>
          <pre>
            <code>{`PUT /v1/locations/{location_id}/bills/{external_bill_id}
X-Restec-Signature: v1=&lt;lowercase-hmac&gt;
Idempotency-Key: bill-INV-1001-v1`}</code>
          </pre>
        </div>
      </section>
    </main>
  );
}
