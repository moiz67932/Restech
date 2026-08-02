import Link from 'next/link';
export default function OpenApi() {
  return (
    <main className="docs-layout">
      <aside className="sidebar">
        <strong>Resources</strong>
        <h4>CONTRACT</h4>
        <Link href="/resources/postman">Postman</Link>
        <Link href="/resources/examples">Examples</Link>
        <Link className="active" href="/resources/openapi">
          OpenAPI
        </Link>
      </aside>
      <article className="doc-content">
        <div className="eyebrow">RESOURCES</div>
        <h1>OpenAPI contract</h1>
        <p className="lede">
          The raw YAML is the single authoritative public API contract used to build the API
          reference.
        </p>
        <a className="button primary" href="/downloads/restec-pos-partner-v1.yaml">
          Download OpenAPI YAML
        </a>
        <h2>Public route boundary</h2>
        <p>
          The contract contains only Restec Partner API routes. Do not call private services or
          construct URLs from internal identifiers.
        </p>
      </article>
      <aside className="toc">
        <strong>On this page</strong>Public route boundary
      </aside>
    </main>
  );
}
