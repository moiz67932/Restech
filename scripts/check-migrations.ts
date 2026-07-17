import { readFile, readdir } from 'node:fs/promises';
const files = (await readdir('supabase/migrations')).filter((v) => v.endsWith('.sql'));
if (!files.length) throw new Error('No migrations found');
const migrations = await Promise.all(
  files.map(async (file) => ({
    file,
    sql: (await readFile(`supabase/migrations/${file}`, 'utf8')).toLowerCase(),
  })),
);
for (const migration of migrations)
  if (!migration.sql.includes('rollback'))
    throw new Error(`${migration.file} missing rollback notes`);
const all = migrations.map((v) => v.sql).join('\n');
for (const required of [
  'enable row level security',
  'claim_pos_outbox',
  'accept_private_event',
  'release_expired_pos_outbox_leases',
])
  if (!all.includes(required)) throw new Error(`Migration set missing ${required}`);
console.log(`Checked ${files.length} migration(s).`);
