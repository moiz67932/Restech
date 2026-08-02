import Link from 'next/link';
export default function NotFound() {
  return (
    <main className="shell hero">
      <div className="eyebrow">404 · NOT FOUND</div>
      <h1>That page moved.</h1>
      <p className="lede">
        Use the public guide index or API reference to find the current v1 contract.
      </p>
      <Link className="button primary" href="/docs">
        Browse documentation
      </Link>
    </main>
  );
}
