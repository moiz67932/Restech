import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
const publicFile = 'docs/openapi/restec-pos-public-api.yaml';
const source = await readFile('apps/api/src/app.ts', 'utf8');
const implemented = new Set<string>();
for (const match of source.matchAll(/(?:app|api)\.(get|put|post)\('([^']+)'/g)) {
  const [, method, rawPath] = match;
  if (rawPath === '/health' || rawPath?.startsWith('/v1/'))
    implemented.add(`${method!.toUpperCase()} ${rawPath!.replace(/:([A-Za-z]+)/g, '{$1}')}`);
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
    for (const [path, item] of Object.entries(value.paths as Record<string, any>))
      for (const method of ['get', 'put', 'post', 'patch', 'delete'])
        if (item[method]) documented.add(`${method.toUpperCase()} ${path}`);
    const missingFromDocs = [...implemented].filter((route) => !documented.has(route));
    const missingFromCode = [...documented].filter((route) => !implemented.has(route));
    if (missingFromDocs.length || missingFromCode.length)
      throw new Error(
        `Public route drift detected. Missing from docs: ${missingFromDocs.join(', ') || 'none'}. Missing from code: ${missingFromCode.join(', ') || 'none'}.`,
      );
    for (const [path, item] of Object.entries(value.paths as Record<string, any>)) {
      for (const method of ['put', 'post']) {
        const operation = item[method];
        if (!operation || path === '/health') continue;
        const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])];
        if (!parameters.some((parameter: any) => parameter.$ref?.endsWith('/IdempotencyKey')))
          throw new Error(`${method.toUpperCase()} ${path} is missing Idempotency-Key.`);
      }
    }
  }
}
