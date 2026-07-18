import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const collection = JSON.parse(
  await readFile('docs/postman/restec-sandbox.postman_collection.json', 'utf8'),
) as any;
const variables = new Set(collection.variable?.map((value: any) => value.key));
for (const key of [
  'base_url',
  'api_key',
  'request_signing_secret',
  'webhook_signing_secret',
  'location_id',
  'external_bill_id',
])
  if (!variables.has(key)) throw new Error(`Postman collection missing ${key}`);

const samples = [
  'curl.md',
  'node-typescript.ts',
  'python.py',
  'php.php',
  'RestecExample.java',
  'RestecExample.cs',
  'restec_example.go',
];
for (const sample of samples) {
  const content = await readFile(`docs/samples/${sample}`, 'utf8');
  for (const required of ['Idempotency-Key', 'X-Restec-Event-Id', 'X-Restec-Signature'])
    if (!content.includes(required)) throw new Error(`${sample} missing ${required}`);
}
const nodeSample = await readFile('docs/samples/node-typescript.ts', 'utf8');
const result = ts.transpileModule(nodeSample, {
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext },
});
if (result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error))
  throw new Error('Node.js/TypeScript sample has syntax errors');
console.log('Validated Postman collection and seven public language samples.');
