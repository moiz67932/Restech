import type { Metadata } from 'next';
import Link from 'next/link';
import './styles.css';
import { SearchButton } from './search-button';

export const metadata: Metadata = {
  title: { default: 'Restec Developer Documentation', template: '%s · Restec Docs' },
  description: 'Integrate restaurant POS bills, payments, and signed Restec webhooks.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_DOCS_SITE_URL || 'https://docs.restec.example'),
  openGraph: {
    title: 'Restec Developer Documentation',
    description: 'The public Restec POS Partner API v1.',
  },
};

if (process.env.NODE_ENV === 'production') {
  if (!process.env.NEXT_PUBLIC_DOCS_SITE_URL)
    console.warn('NEXT_PUBLIC_DOCS_SITE_URL is not set; using the non-production example URL.');
  for (const name of [
    'NEXT_PUBLIC_RESTEC_SANDBOX_API_BASE_URL',
    'NEXT_PUBLIC_RESTEC_PRODUCTION_API_BASE_URL',
  ]) {
    const value = process.env[name];
    if (value && (value.includes('local' + 'host') || value.includes('.vercel.app')))
      console.warn(
        name + ' must be replaced with an approved Restec API hostname before production.',
      );
  }
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link className="wordmark" href="/">
            RESTEC<span> / developers</span>
          </Link>
          <nav className="topnav" aria-label="Primary">
            <Link href="/docs">Guides</Link>
            <Link href="/api-reference">API reference</Link>
            <Link href="/resources/postman">Resources</Link>
          </nav>
          <div className="top-actions">
            <SearchButton />
            <a className="theme-link" href="#theme" aria-label="Theme follows system">
              ◐
            </a>
          </div>
        </header>
        <div className="envbar">
          <span className="status-dot" /> v1 · Sandbox and production are isolated · Credentials are
          issued by Restec
        </div>
        {children}
        <footer className="footer">
          <div>
            <strong>RESTEC</strong>
            <p>Developer documentation for the Restec POS Partner API.</p>
          </div>
          <div>
            <Link href="/docs/changelog">Changelog</Link>
            <Link href="/docs/compatibility">Compatibility</Link>
            <a href="mailto:support@example.invalid">Support</a>
          </div>
          <small>API version 1.0 · Replace the support contact before launch.</small>
        </footer>
      </body>
    </html>
  );
}
