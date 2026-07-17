import { readFile, readdir } from 'node:fs/promises';
const files = (await readdir('supabase/migrations')).filter((v) => v.endsWith('.sql'));
if (!files.length) throw new Error('No migrations found');
for (const file of files) {
  const sql = await readFile(`supabase/migrations/${file}`, 'utf8');
  for (const required of ['enable row level security', 'claim_pos_outbox', 'rollback'])
    if (!sql.toLowerCase().includes(required)) throw new Error(`${file} missing ${required}`);
}
console.log(`Checked ${files.length} migration(s).`);
