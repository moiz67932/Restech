import Link from 'next/link';
export default function Examples() {
  return (
    <main className="docs-layout">
      <aside className="sidebar">
        <strong>Resources</strong>
        <h4>CODE</h4>
        <Link href="/resources/postman">Postman</Link>
        <Link className="active" href="/resources/examples">
          Examples
        </Link>
      </aside>
      <article className="doc-content">
        <div className="eyebrow">RESOURCES</div>
        <h1>Language examples</h1>
        <p className="lede">
          Complete public-contract samples with fresh request IDs, HMAC signing, idempotency, safe
          retries, and redacted placeholders.
        </p>
        <div className="resource-grid">
          {[
            ['curl', '/downloads/restec-curl.sh'],
            ['Node.js', '/downloads/restec-node.mjs'],
            ['C#', '/downloads/restec-csharp.cs'],
            ['Java', '/downloads/restec-java.java'],
          ].map(([n, h]) => (
            <a className="resource" href={h} key={n}>
              <h3>{n} ↗</h3>
              <p>Download the verified example.</p>
            </a>
          ))}
        </div>
      </article>
      <aside className="toc">
        <strong>On this page</strong>Downloads
      </aside>
    </main>
  );
}
