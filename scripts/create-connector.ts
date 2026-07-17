import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9-]+$/.test(name))
  throw new Error('Usage: npm run create:connector -- vendor-name');
const root = resolve('packages/connectors', name);
await mkdir(`${root}/fixtures`, { recursive: true });
await mkdir(`${root}/tests`, { recursive: true });
console.log(
  `Created connector directories at ${root}. Add index.ts, types.ts, schemas.ts, authentication.ts, translator.ts, delivery.ts, tests, fixtures, and README.md using verified vendor documentation.`,
);
