import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = join(root, 'apps', 'api');
const failures = [];

const fail = (message) => failures.push(message);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const normalized = (path) => path.split(sep).join('/');

const packageDirectories = [];
const collectPackageDirectories = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (existsSync(join(path, 'package.json'))) packageDirectories.push(path);
    else collectPackageDirectories(path);
  }
};
collectPackageDirectories(join(root, 'packages'));

const packagesByName = new Map(
  packageDirectories.map((directory) => {
    const manifest = readJson(join(directory, 'package.json'));
    return [manifest.name, { directory, manifest }];
  }),
);

const apiManifest = readJson(join(apiRoot, 'package.json'));
const runtimePackages = new Set();
const queue = Object.keys(apiManifest.dependencies ?? {}).filter((name) =>
  name.startsWith('@restec/'),
);
while (queue.length) {
  const name = queue.shift();
  if (runtimePackages.has(name)) continue;
  const workspacePackage = packagesByName.get(name);
  if (!workspacePackage) {
    fail(`API runtime dependency ${name} is not a discovered workspace package.`);
    continue;
  }
  runtimePackages.add(name);
  for (const dependency of Object.keys(workspacePackage.manifest.dependencies ?? {})) {
    if (dependency.startsWith('@restec/')) queue.push(dependency);
  }
}

const exportTarget = (manifest) => {
  const rootExport = manifest.exports?.['.'] ?? manifest.exports;
  if (typeof rootExport === 'string') return rootExport;
  return rootExport?.import ?? rootExport?.default;
};

for (const name of [...runtimePackages].sort()) {
  const { directory, manifest } = packagesByName.get(name);
  const expectedJavaScript = './dist/index.js';
  const expectedTypes = './dist/index.d.ts';
  if (manifest.main !== expectedJavaScript) fail(`${name} main must be ${expectedJavaScript}.`);
  if (manifest.module !== expectedJavaScript) fail(`${name} module must be ${expectedJavaScript}.`);
  if (manifest.types !== expectedTypes) fail(`${name} types must be ${expectedTypes}.`);
  if (exportTarget(manifest) !== expectedJavaScript)
    fail(`${name} runtime export must be ${expectedJavaScript}.`);
  const rootExport = manifest.exports?.['.'] ?? manifest.exports;
  if (typeof rootExport !== 'object' || rootExport.types !== expectedTypes)
    fail(`${name} export types condition must be ${expectedTypes}.`);
  if (!existsSync(join(directory, 'dist', 'index.js')))
    fail(`${name} is missing dist/index.js; build API dependencies before packaging.`);
  if (!existsSync(join(directory, 'dist', 'index.d.ts')))
    fail(`${name} is missing dist/index.d.ts; declarations were not emitted.`);

  try {
    const resolved = fileURLToPath(import.meta.resolve(name));
    const relativeResolution = normalized(relative(directory, realpathSync(resolved)));
    if (relativeResolution !== 'dist/index.js')
      fail(`${name} resolves to ${relativeResolution}, not dist/index.js.`);
  } catch (error) {
    fail(
      `${name} could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const functionEntry = join(apiRoot, 'api', 'index.mjs');
const functionSource = readFileSync(functionEntry, 'utf8');
if (!functionSource.includes("from '../dist/bootstrap.js'"))
  fail('The Vercel function entry must import ../dist/bootstrap.js.');
if (!/export\s+const\s+fetch\s*=/.test(functionSource))
  fail('The Vercel function entry must expose a named Fetch API handler.');
if (/export\s+default\b/.test(functionSource))
  fail('The Vercel function entry must not use the default (req, res) handler signature.');
if (functionSource.includes("from 'hono/vercel'"))
  fail("The Vercel function entry must not wrap the app in Hono's default-export adapter.");
if (/(?:from\s+|import\s*\()["'][^"']*(?:\/src\/|\.ts["'])/.test(functionSource))
  fail('The Vercel function entry contains a raw TypeScript/source runtime import.');

const vercelConfig = readJson(join(apiRoot, 'vercel.json'));
if (vercelConfig.framework !== null)
  fail(
    'vercel.json must disable framework auto-detection to prevent a second raw-source function.',
  );
if (vercelConfig.buildCommand !== 'npm run build')
  fail('vercel.json must enforce npm run build before function packaging.');
if (vercelConfig.outputDirectory !== 'public' || !existsSync(join(apiRoot, 'public')))
  fail('The function-only Vercel project must provide its configured public output directory.');
const includeFiles = vercelConfig.functions?.['api/index.mjs']?.includeFiles;
const expectedIncludeFiles = '{dist/**,../../packages/**/{package.json,dist/**}}';
if (includeFiles !== expectedIncludeFiles)
  fail(`Vercel includeFiles must be the compiled-output-only glob ${expectedIncludeFiles}.`);

const importPatterns = [
  /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const graphQueue = [join(apiRoot, 'dist', 'bootstrap.js')];
const visited = new Set();
while (graphQueue.length) {
  const file = realpathSync(graphQueue.shift());
  if (visited.has(file)) continue;
  visited.add(file);
  const source = readFileSync(file, 'utf8');
  for (const pattern of importPatterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      let resolved;
      if (specifier.startsWith('.')) {
        resolved = resolve(dirname(file), specifier);
      } else if (specifier.startsWith('@restec/')) {
        const workspacePackage = packagesByName.get(specifier);
        if (!workspacePackage) {
          fail(`Compiled runtime graph imports unknown workspace package ${specifier}.`);
          continue;
        }
        resolved = join(workspacePackage.directory, exportTarget(workspacePackage.manifest));
      } else {
        continue;
      }
      const resolvedName = normalized(resolved);
      if (extname(resolved) === '.ts' || resolvedName.includes('/src/'))
        fail(
          `${normalized(relative(root, file))} resolves ${specifier} to raw source ${resolvedName}.`,
        );
      if (!existsSync(resolved)) {
        fail(`${normalized(relative(root, file))} has missing runtime import ${specifier}.`);
        continue;
      }
      if (extname(resolved) === '.js') graphQueue.push(resolved);
    }
  }
}

try {
  const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
  execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.erasable.json')], {
    cwd: root,
    stdio: 'inherit',
  });
} catch {
  fail('The erasableSyntaxOnly TypeScript verification failed.');
}

try {
  execFileSync(process.execPath, [join(root, 'scripts', 'smoke-built-api.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
} catch {
  fail('The compiled API startup smoke test failed.');
}

if (failures.length) {
  process.stderr.write('Vercel runtime verification failed:\n');
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write(
  `Vercel runtime verified: ${runtimePackages.size} internal packages resolve to compiled ESM and ${visited.size} compiled runtime modules contain no raw TypeScript dependencies.\n`,
);
