import { readFile, readdir } from 'node:fs/promises';
const files = (await readdir('supabase/migrations')).filter((v) => v.endsWith('.sql')).sort();
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
  'store_sandbox_credentials',
  'provision_pos_partner',
  'rotate_pos_partner_credential',
  'revoke_pos_partner_credential',
  'credential_version',
  'location_scopes',
  'grace_ends_at',
  'rotated_from',
])
  if (!all.includes(required)) throw new Error(`Migration set missing ${required}`);

const billStateMigrations = migrations.filter((migration) =>
  migration.sql.includes('function public.persist_restec_bill_state'),
);
const latestBillStateMigration = billStateMigrations.at(-1);
if (!latestBillStateMigration) throw new Error('Migration set missing persist_restec_bill_state');
const normalizedBillStateMigration = latestBillStateMigration.sql.replace(/\s+/g, ' ');
if (
  !normalizedBillStateMigration.includes(
    "p_request_hash, p_public_state->>'payment_status', coalesce(p_public_state->>'reconciliation_status','pending'), p_public_state",
  )
)
  throw new Error(
    `${latestBillStateMigration.file} has an invalid bill-state insert value projection`,
  );
console.log(`Checked ${files.length} migration(s).`);
