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
];
const roots = [
  'apps/docs',
  'apps/portal',
  'docs/openapi/restec-pos-public-api.yaml',
  'docs/samples',
  'docs/postman',
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
