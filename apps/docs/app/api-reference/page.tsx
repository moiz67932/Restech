import Link from 'next/link';
import { apiOperations } from '../lib/content';
export default function ApiIndex() {
  const ops = apiOperations();
  return (
    <main className="docs-layout">
      <aside className="sidebar">
        <strong>API reference</strong>
        <h4>ENDPOINTS</h4>
        {ops.map((o) => (
          <a href={'#' + o.path} key={o.method + o.path}>
            <span className="method">{o.method}</span>
            {o.path}
          </a>
        ))}
      </aside>
      <article className="doc-content">
        <div className="eyebrow">MACHINE-READABLE CONTRACT · OPENAPI 3.1</div>
        <h1>Restec POS Partner API</h1>
        <p className="lede">
          Endpoint pages are generated from the canonical OpenAPI contract. Every route below is
          public and location-scoped.
        </p>
        <div className="actions">
          <Link className="button primary" href="/resources/openapi">
            Download OpenAPI YAML
          </Link>
        </div>
        <div className="api-list">
          {ops.map((o) => (
            <section className="api-item" id={o.path} key={o.method + o.path}>
              <span className="method">{o.method}</span>
              <span className="path">{o.path}</span>
              <p>
                See the authoritative contract for parameters, required headers, schemas, responses,
                idempotency, and retry behavior.
              </p>
              <Link
                className="inline-link"
                href={'/api-reference/' + encodeURIComponent(o.path.replaceAll('/', '_'))}
              >
                Open endpoint details →
              </Link>
            </section>
          ))}
        </div>
      </article>
      <aside className="toc">
        <strong>On this page</strong>Endpoints
      </aside>
    </main>
  );
}
