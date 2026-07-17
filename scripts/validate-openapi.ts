import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
for (const file of [
  'docs/openapi/restec-pos-public-api.yaml',
  'docs/openapi/restec-internal-api.yaml',
]) {
  const value = YAML.parse(await readFile(file, 'utf8'));
  if (value.openapi !== '3.1.0' || !value.info || !value.paths)
    throw new Error(`${file} is not a valid OpenAPI 3.1 document`);
  console.log(`Validated ${file}`);
}
