import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
const restricted = [
  /paely/i,
  /payly/i,
  /safepay/i,
  /supabase/i,
  /commission/i,
  /settlement rules?/i,
  /psp fees?/i,
  /split[- ]settlement/i,
  /bank details?/i,
  /vercel project/i,
  /stack trace/i,
  /private[_ -]paely/i,
  /paely_order_id/i,
  /private (?:bill|table|connection) (?:id|reference)/i,
  /merchant_payment_accounts/i,
  /private_connection_reference/i,
  /private_location_reference/i,
  /private_event_inbox/i,
  /pos_outbox_events/i,
  /pps_[A-Za-z0-9_]+/i,
  /\/api\/internal(?:\/|\b)/i,
  /\/api\/test(?:\/|\b)/i,
  /\/v1\/test(?:\/|\b)/i,
  /vercel\.app/i,
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::|\/|\b)/i,
  /https?:\/\/[^/\s"']*(?:\.internal|\.local)(?::|\/|\b)/i,
  /https?:\/\/(?:internal|private)[.-]/i,
  /X-Restec-Service-Id/i,
  /PAELY_PRIVATE_BASE_URL/i,
  /postgres(?:ql)? function/i,
];
const roots = [
  'apps/docs',
  'apps/portal',
  'openapi/restec-pos-partner-v1.yaml',
  'docs/pos-partner',
  'postman/Restec-POS-Partner-v1.postman_collection.json',
  'postman/Restec-POS-Partner-Sandbox.postman_environment.json',
  'examples/curl',
  'examples/node',
  'examples/csharp',
  'examples/java',
  'docs/samples',
  'docs/postman',
  'docs/RESTEC_POS_INTEGRATION_GUIDE.md',
  'docs/RESTEC_POS_CERTIFICATION_CHECKLIST.md',
];
async function files(path: string): Promise<string[]> {
  const stat = await import('node:fs/promises').then((fs) => fs.stat(path));
  if (stat.isFile()) return [path];
  const entries = (await readdir(path, { withFileTypes: true })).filter(
    (entry) => !['.next', 'node_modules', 'dist'].includes(entry.name),
  );
  return (
    await Promise.all(
      entries.map((e) => (e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)])),
    )
  ).flat();
}
const failures: string[] = [];
for (const root of roots) {
  for (const file of await files(root)) {
    if (['.png', '.jpg', '.ico'].includes(extname(file))) continue;
    const content = await readFile(file, 'utf8');
    for (const pattern of restricted)
      if (pattern.test(content)) failures.push(`${file}: ${pattern}`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log('Public-content leakage scan passed.');
