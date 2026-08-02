import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), '..', '..');
const docsDir = path.join(root, 'docs', 'pos-partner');
export type Doc = { slug: string; title: string; body: string; description: string };
const titleOf = (body: string, fallback: string) =>
  body.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
const descOf = (body: string) =>
  body.replace(/^#.*$/m, '').replace(/[_*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
export function allDocs(): Doc[] {
  if (!fs.existsSync(docsDir)) return [];
  return fs
    .readdirSync(docsDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const body = fs.readFileSync(path.join(docsDir, name), 'utf8');
      return {
        slug: name.replace(/\.md$/, '').toLowerCase().replaceAll('_', '-'),
        title: titleOf(body, name),
        body,
        description: descOf(body),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}
export function getDoc(slug: string) {
  return allDocs().find((doc) => doc.slug === slug);
}
export function openApiText() {
  return fs.readFileSync(path.join(root, 'openapi', 'restec-pos-partner-v1.yaml'), 'utf8');
}
export function publicFile(relative: string) {
  return fs.readFileSync(path.join(root, relative));
}
export function apiOperations() {
  const lines = openApiText().split(/\r?\n/);
  const out: { method: string; path: string }[] = [];
  let current = '';
  for (const line of lines) {
    const p = line.match(/^ {2}(\/[^:]+):\s*$/);
    if (p) current = p[1];
    const m = line.match(/^ {4}(get|put|post|delete|patch):\s*$/);
    if (m && current) out.push({ method: m[1].toUpperCase(), path: current });
  }
  return out;
}
export const nav: Array<[string, string[]]> = [
  ['Start here', ['quickstart', 'authentication', 'api-overview']],
  [
    'Build',
    [
      'bill-and-order-sync',
      'payment-sync',
      'traditional-payment-sync',
      'webhooks',
      'idempotency-retries',
    ],
  ],
  [
    'Operate',
    [
      'errors',
      'credential-ownership-matrix',
      'onboarding-checklist',
      'uat-test-plan',
      'go-live-checklist',
      'troubleshooting',
    ],
  ],
  ['Policy', ['compatibility-policy', 'changelog']],
];
export function renderMarkdown(body: string) {
  const tick = String.fromCharCode(96);
  const escape = (s: string) =>
    s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  let html = '',
    inCode = false,
    code = '';
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith(tick.repeat(3))) {
      if (inCode) {
        html += '<pre><code>' + escape(code) + '</code></pre>';
        code = '';
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code += line + '\n';
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      const n = h[1].length;
      const t = h[2].replaceAll(tick, '');
      html +=
        '<h' +
        n +
        ' id="' +
        t.toLowerCase().replace(/[^a-z0-9]+/g, '-') +
        '">' +
        t +
        '</h' +
        n +
        '>';
      continue;
    }
    if (line.startsWith('|')) {
      html += '<p>' + escape(line) + '</p>';
      continue;
    }
    if (/^[-*] /.test(line)) {
      html += '<li>' + escape(line.slice(2)) + '</li>';
      continue;
    }
    if (/^\d+\. /.test(line)) {
      html += '<p><strong>' + escape(line.slice(line.indexOf(' ') + 1)) + '</strong></p>';
      continue;
    }
    if (line.trim())
      html +=
        '<p>' +
        escape(line).replace(
          new RegExp(tick + '([^' + tick + ']+)' + tick, 'g'),
          '<code>$1</code>',
        ) +
        '</p>';
  }
  return html;
}
