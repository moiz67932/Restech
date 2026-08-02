import { notFound } from 'next/navigation';
import { apiOperations, openApiText } from '../../lib/content';
export function generateStaticParams() {
  return apiOperations().map((o) => ({ slug: encodeURIComponent(o.path.replaceAll('/', '_')) }));
}
export default async function Endpoint({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const op = apiOperations().find((o) => encodeURIComponent(o.path.replaceAll('/', '_')) === slug);
  if (!op) notFound();
  const contract = openApiText();
  const relevant = contract
    .split(/\r?\n/)
    .filter(
      (l) =>
        l.includes(op.path) ||
        l.includes('operationId') ||
        l.includes('security') ||
        l.includes('Idempotency') ||
        l.includes('X-Restec'),
    )
    .slice(0, 16)
    .join('\n');
  return (
    <main className="docs-layout">
      <aside className="sidebar">
        <strong>API reference</strong>
        <h4>ENDPOINT</h4>
        <a className="active">
          {op.method} {op.path}
        </a>
      </aside>
      <article className="doc-content">
        <div className="eyebrow">OPENAPI-DRIVEN ENDPOINT</div>
        <h1>
          <span className="method">{op.method}</span> {op.path}
        </h1>
        <p className="lede">
          Public Restec Partner API endpoint. Sign the exact raw body and send a fresh request ID
          for each attempt.
        </p>
        <h2>Authentication and retries</h2>
        <p>
          Use the credential scope documented for this operation. Mutations require an idempotency
          key; reuse the same key and exact body when retrying an ambiguous response. Reconcile with
          a signed GET after a timeout.
        </p>
        <h2>Contract excerpt</h2>
        <pre>
          <code>{relevant}</code>
        </pre>
        <p>
          <a className="inline-link" href="/resources/openapi">
            View and download the full OpenAPI contract →
          </a>
        </p>
      </article>
      <aside className="toc">
        <strong>On this page</strong>
        <a href="#authentication-and-retries">Auth & retries</a>
        <a href="#contract-excerpt">Contract excerpt</a>
      </aside>
    </main>
  );
}
