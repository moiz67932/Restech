import Link from 'next/link';
import { allDocs, nav } from '../lib/content';
export default function DocsIndex() {
  const docs = allDocs();
  return (
    <main className="docs-layout">
      <aside className="sidebar">
        <strong>Documentation</strong>
        {nav.map(([group, slugs]) => (
          <div key={group}>
            <h4>{group}</h4>
            {(slugs as string[]).map((s) => (
              <Link key={s} href={'/docs/' + s}>
                {docs.find((d) => d.slug === s)?.title || s}
              </Link>
            ))}
          </div>
        ))}
      </aside>
      <article className="doc-content">
        <div className="eyebrow">RESTEC POS PARTNER API · V1</div>
        <h1>Integration guides</h1>
        <p className="lede">The public path from credentials to a certified sandbox integration.</p>
        <div className="resource-grid">
          {docs.map((d) => (
            <Link className="resource" href={'/docs/' + d.slug} key={d.slug}>
              <h3>{d.title} ↗</h3>
              <p>{d.description}</p>
            </Link>
          ))}
        </div>
      </article>
      <aside className="toc">
        <strong>On this page</strong>Guide index
      </aside>
    </main>
  );
}
