import Link from 'next/link';
export default function Postman() {
  return (
    <main className="docs-layout">
      <aside className="sidebar">
        <strong>Resources</strong>
        <h4>DOWNLOADS</h4>
        <Link className="active" href="/resources/postman">
          Postman
        </Link>
        <Link href="/resources/examples">Examples</Link>
        <Link href="/resources/openapi">OpenAPI</Link>
      </aside>
      <article className="doc-content">
        <div className="eyebrow">RESOURCES</div>
        <h1>Postman sandbox kit</h1>
        <p className="lede">
          Import the collection, select the environment template, and replace only the values Restec
          supplies during onboarding.
        </p>
        <div className="resource-grid">
          <a className="resource" href="/downloads/restec-postman-collection.json">
            <h3>Collection ↗</h3>
            <p>Signed v1 requests for health, bills, payments, tables, and payment sessions.</p>
          </a>
          <a className="resource" href="/downloads/restec-postman-sandbox.json">
            <h3>Sandbox environment ↗</h3>
            <p>Placeholders only. Never commit issued credentials.</p>
          </a>
        </div>
        <h2>Import sequence</h2>
        <ol>
          <li>Import both JSON files into Postman.</li>
          <li>Replace the base URL and placeholders supplied by Restec.</li>
          <li>Run Health, then List tables, then the bill request.</li>
          <li>
            Keep request signing enabled and never paste production secrets into browser tools.
          </li>
        </ol>
      </article>
      <aside className="toc">
        <strong>On this page</strong>Import sequence
      </aside>
    </main>
  );
}
