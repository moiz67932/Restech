import { NextResponse } from 'next/server';
import { allDocs } from '../lib/content';
export function GET() {
  return NextResponse.json(
    allDocs().map(({ slug, title, description }) => ({ slug, title, description })),
    { headers: { 'Cache-Control': 'public, max-age=3600' } },
  );
}
