import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import {
  billItemSchema,
  billSchema,
  externalPaymentSchema,
  partnerWebhookEventSchema,
  paymentSessionRequestSchema,
} from '../packages/contracts/src/index.js';

const publicFile = 'openapi/restec-pos-partner-v1.yaml';
const source = await readFile('apps/api/src/app.ts', 'utf8');
const implemented = new Set<string>();
for (const match of source.matchAll(/(?:app|api)\.(get|put|post)\('([^']+)'/g)) {
  const [, method, rawPath] = match;
  if (
    rawPath === '/health' ||
    (rawPath?.startsWith('/v1/') && rawPath !== '/v1/test' && !rawPath.startsWith('/v1/test/'))
  )
    implemented.add(
      `${method!.toUpperCase()} ${rawPath!.replace(/:([A-Za-z]+)/g, '{}').replace(/\{[^}]+\}/g, '{}')}`,
    );
}
for (const file of [publicFile, 'docs/openapi/restec-internal-api.yaml']) {
  const value = YAML.parse(await readFile(file, 'utf8'));
  if (value.openapi !== '3.1.0' || !value.info || !value.paths)
    throw new Error(`${file} is not a valid OpenAPI 3.1 document`);
  console.log(`Validated ${file}`);
  if (file === publicFile) {
    if (!value.components?.responses?.Bill || !value.components?.responses?.Error)
      throw new Error('Public OpenAPI is missing reusable response components.');
    if (!value.webhooks?.paymentStatusChanged?.post)
      throw new Error('Public OpenAPI is missing the outbound payment webhook.');
    const documented = new Set<string>();
    const operationIds = new Set<string>();
    for (const [path, item] of Object.entries(value.paths as Record<string, any>))
      for (const method of ['get', 'put', 'post', 'patch', 'delete'])
        if (item[method]) {
          documented.add(`${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, '{}')}`);
          const operationId = item[method].operationId;
          if (!operationId || operationIds.has(operationId))
            throw new Error(
              `${method.toUpperCase()} ${path} has a missing or duplicate operationId.`,
            );
          operationIds.add(operationId);
        }
    const missingFromDocs = [...implemented].filter((route) => !documented.has(route));
    const missingFromCode = [...documented].filter((route) => !implemented.has(route));
    if (missingFromDocs.length || missingFromCode.length)
      throw new Error(
        `Public route drift detected. Missing from docs: ${missingFromDocs.join(', ') || 'none'}. Missing from code: ${missingFromCode.join(', ') || 'none'}.`,
      );
    for (const [path, item] of Object.entries(value.paths as Record<string, any>)) {
      if (path.startsWith('/api/') || path === '/v1/test' || path.startsWith('/v1/test/'))
        throw new Error(`Non-partner route entered the public OpenAPI document: ${path}`);
      for (const method of ['put', 'post']) {
        const operation = item[method];
        if (!operation || path === '/health') continue;
        const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])];
        if (!parameters.some((parameter: any) => parameter.$ref?.endsWith('/IdempotencyKey')))
          throw new Error(`${method.toUpperCase()} ${path} is missing Idempotency-Key.`);
      }
    }

    const schemas = value.components.schemas as Record<string, any>;
    const objectShape = (schema: any) => (schema._def?.schema ?? schema).shape;
    const requiredKeys = (schema: any) =>
      Object.entries(objectShape(schema))
        .filter(([, property]: [string, any]) => !property.isOptional())
        .map(([key]) => key)
        .sort();
    const same = (label: string, actual: unknown[], expected: unknown[]) => {
      if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort()))
        throw new Error(`${label} differs from the runtime contract.`);
    };
    same('BillInput required fields', schemas.BillInput.required, requiredKeys(billSchema));
    same('Item required fields', schemas.Item.required, requiredKeys(billItemSchema));
    same(
      'ExternalPayment required fields',
      schemas.ExternalPayment.required,
      requiredKeys(externalPaymentSchema),
    );
    same(
      'PaymentSessionInput required fields',
      schemas.PaymentSessionInput.required,
      requiredKeys(paymentSessionRequestSchema),
    );
    same(
      'PartnerWebhookEvent required fields',
      schemas.PartnerWebhookEvent.required,
      requiredKeys(partnerWebhookEventSchema),
    );
    same(
      'External payment methods',
      schemas.ExternalPayment.properties.method.enum,
      externalPaymentSchema.shape.method.options,
    );
    same(
      'Partner webhook event types',
      schemas.PartnerWebhookEvent.properties.event_type.enum,
      partnerWebhookEventSchema.shape.event_type.options,
    );
    same(
      'Partner webhook payment methods',
      schemas.PartnerWebhookEvent.properties.payment_method.enum,
      partnerWebhookEventSchema.shape.payment_method.options,
    );
  }
}
