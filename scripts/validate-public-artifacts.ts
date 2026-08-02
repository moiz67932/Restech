import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import {
  billSchema,
  externalPaymentSchema,
  partnerWebhookEventSchema,
  paymentSessionRequestSchema,
} from '../packages/contracts/src/index.js';

const collectionPath = 'postman/Restec-POS-Partner-v1.postman_collection.json';
const environmentPath = 'postman/Restec-POS-Partner-Sandbox.postman_environment.json';
const collection = JSON.parse(await readFile(collectionPath, 'utf8')) as any;
const environment = JSON.parse(await readFile(environmentPath, 'utf8')) as any;
const openapi = YAML.parse(await readFile('openapi/restec-pos-partner-v1.yaml', 'utf8')) as any;

if (
  collection.info?.schema !== 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
)
  throw new Error('Postman collection is not v2.1.');
if (environment._postman_variable_scope !== 'environment')
  throw new Error('Postman sandbox environment has an invalid schema.');

const collectionVariables = new Set(collection.variable?.map((value: any) => value.key));
const environmentVariables = new Set(environment.values?.map((value: any) => value.key));
for (const key of [
  'base_url',
  'api_key',
  'request_signing_secret',
  'webhook_signing_secret',
  'location_id',
  'external_bill_id',
  'payment_session_id',
  'environment',
]) {
  if (!collectionVariables.has(key)) throw new Error(`Postman collection missing ${key}.`);
  if (!environmentVariables.has(key)) throw new Error(`Postman environment missing ${key}.`);
}

const normalized = (path: string) => path.replace(/\{\{[^}]+\}\}|\{[^}]+\}/g, '{}');
const documented = new Set<string>();
for (const [path, item] of Object.entries(openapi.paths as Record<string, any>))
  for (const method of ['get', 'put', 'post'])
    if (item[method]) documented.add(`${method.toUpperCase()} ${normalized(path)}`);
const collected = new Set<string>();
for (const item of collection.item as any[]) {
  const url = String(item.request?.url ?? '').replace('{{base_url}}', '');
  if (!url.startsWith('/')) throw new Error(`Postman request ${item.name} has an invalid URL.`);
  collected.add(`${item.request.method} ${normalized(url)}`);
}
for (const route of documented)
  if (!collected.has(route)) throw new Error(`Postman collection is missing ${route}.`);
for (const route of collected)
  if (!documented.has(route)) throw new Error(`Postman collection contains undocumented ${route}.`);

const byName = new Map(collection.item.map((item: any) => [item.name, item]));
const rawBody = (name: string) => JSON.parse(byName.get(name)?.request?.body?.raw ?? 'null');
billSchema.parse(rawBody('Create or update bill'));
externalPaymentSchema.parse(rawBody('Record external payment'));
paymentSessionRequestSchema.parse(rawBody('Create hosted payment session'));
partnerWebhookEventSchema.parse(openapi.components.schemas.PartnerWebhookEvent.example);

const examples = [
  'examples/curl/README.md',
  'examples/curl/restec.sh',
  'examples/node/restec-client.mjs',
  'examples/node/examples.mjs',
  'examples/csharp/Program.cs',
  'examples/java/RestecPartnerExample.java',
];
const combined = (await Promise.all(examples.map((file) => readFile(file, 'utf8')))).join('\n');
for (const required of [
  'Idempotency-Key',
  'X-Restec-Event-Id',
  'X-Restec-Signature',
  'cash',
  'card_terminal',
  '409',
  '422',
  '429',
  'Retry-After',
  'payment-sessions',
  'external-payments',
  'event_id',
])
  if (!combined.includes(required)) throw new Error(`Public examples are missing ${required}.`);

console.log('Validated OpenAPI examples, Postman schemas/routes, and public example coverage.');
