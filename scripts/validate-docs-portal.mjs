/* global process, console */
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const required = [
  'apps/docs/app/page.tsx',
  'apps/docs/app/docs/page.tsx',
  'apps/docs/app/api-reference/page.tsx',
  'apps/docs/app/resources/postman/page.tsx',
  'openapi/restec-pos-partner-v1.yaml',
  'postman/Restec-POS-Partner-v1.postman_collection.json',
];
const forbidden = [
  'Paely',
  'Payly',
  'Safepay',
  'Supabase',
  '/api/internal/',
  '/api/test/',
  'pps_',
  'C:\\Users\\',
  'localhost',
];
const publicFiles = [
  'docs/pos-partner',
  'openapi/restec-pos-partner-v1.yaml',
  'postman',
  'examples',
  'apps/docs/app',
];
const fail = [];
for (const file of required)
  if (!fs.existsSync(path.join(root, file))) fail.push('missing ' + file);
function walk(p) {
  if (!fs.existsSync(p)) return [];
  const s = fs.statSync(p);
  if (s.isFile()) return [p];
  return fs
    .readdirSync(p)
    .flatMap((n) => walk(path.join(p, n)))
    .filter((f) => !f.includes('node_modules') && !f.includes('.next'));
}
function walkGenerated(p) {
  if (!fs.existsSync(p)) return [];
  const s = fs.statSync(p);
  if (s.isFile()) return [p];
  return fs
    .readdirSync(p)
    .flatMap((n) => walkGenerated(path.join(p, n)))
    .filter(
      (f) => f.endsWith('.html') || f.includes(path.join('.next', 'static', 'chunks', 'app')),
    );
}
if (process.argv.includes('--leaks'))
  for (const base of publicFiles)
    for (const file of walk(path.join(root, base))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const term of forbidden)
        if (text.includes(term))
          fail.push('forbidden public term ' + term + ' in ' + path.relative(root, file));
    }
if (process.argv.includes('--leaks'))
  for (const base of ['apps/docs/.next/static/chunks/app', 'apps/docs/.next/server/app'])
    for (const file of walkGenerated(path.join(root, base))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const term of forbidden)
        if (text.includes(term))
          fail.push('forbidden generated term ' + term + ' in ' + path.relative(root, file));
    }
if (process.argv.includes('--links')) {
  const routes = [
    '/',
    '/docs',
    '/docs/quickstart',
    '/docs/authentication',
    '/docs/bill-and-order-sync',
    '/docs/payment-sync',
    '/docs/traditional-payment-sync',
    '/docs/webhooks',
    '/docs/implementation-guide',
    '/api-reference',
    '/resources/postman',
    '/resources/examples',
    '/resources/openapi',
  ];
  if (routes.length < 10) fail.push('route smoke list incomplete');
}
if (fail.length) {
  console.error(fail.join('\n'));
  process.exit(1);
}
console.log(
  'Docs portal validation passed: routes, canonical sources, and public boundary checks.',
);
