import type { MetadataRoute } from 'next';
import { allDocs } from './lib/content';
export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_DOCS_SITE_URL || 'https://docs.restec.example';
  return [
    '',
    '/docs',
    '/api-reference',
    '/resources/postman',
    '/resources/examples',
    '/resources/openapi',
    ...allDocs().map((d) => '/docs/' + d.slug),
  ].map((path) => ({ url: base + path, lastModified: new Date('2026-08-02') }));
}
