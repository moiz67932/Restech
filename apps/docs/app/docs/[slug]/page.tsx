import { notFound } from 'next/navigation';
import { allDocs, getDoc, nav, renderMarkdown } from '../../lib/content';
import Link from 'next/link';
export function generateStaticParams() {
  return allDocs().map((d) => ({ slug: d.slug }));
}
export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) notFound();
  return (
    <main className="docs-layout">
      <aside className="sidebar">
        <strong>Documentation</strong>
        {nav.map(([group, slugs]) => (
          <div key={group}>
            <h4>{group}</h4>
            {(slugs as string[]).map((s) => (
              <Link className={s === slug ? 'active' : ''} key={s} href={'/docs/' + s}>
                {getDoc(s)?.title || s}
              </Link>
            ))}
          </div>
        ))}
      </aside>
      <article className="doc-content">
        <div className="eyebrow">GUIDE · RESTEC V1</div>
        <h1>{doc.title}</h1>
        <div dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.body) }} />
      </article>
      <aside className="toc">
        <strong>On this page</strong>
        <p>Use the sidebar to continue.</p>
      </aside>
    </main>
  );
}
