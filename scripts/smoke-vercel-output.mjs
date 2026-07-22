import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configureSmokeEnvironment } from './smoke-environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const functionsRoot = join(root, '.vercel', 'output', 'functions');
assert(existsSync(functionsRoot), 'Run vercel build before verifying its output.');

const functionDirectories = [];
const visit = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.func')) functionDirectories.push(path);
      else visit(path);
    }
  }
};
visit(functionsRoot);
assert.equal(functionDirectories.length, 1, 'Vercel output must contain exactly one function');

const functionRoot = functionDirectories[0];
const functionConfig = JSON.parse(readFileSync(join(functionRoot, '.vc-config.json'), 'utf8'));
assert.equal(functionConfig.handler, 'apps/api/api/index.mjs');
assert.equal(functionConfig.runtime, 'nodejs24.x');

const rawWorkspaceTypeScript = [];
const inspectFiles = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inspectFiles(path);
    else if (/packages[\\/].*[\\/]src[\\/].*\.ts$/.test(path)) rawWorkspaceTypeScript.push(path);
  }
};
inspectFiles(functionRoot);
assert.deepEqual(rawWorkspaceTypeScript, [], 'Vercel output contains raw workspace TypeScript');

configureSmokeEnvironment();
const handlerModule = await import(pathToFileURL(join(functionRoot, functionConfig.handler)).href);
assert.equal(typeof handlerModule.fetch, 'function');
assert.equal(handlerModule.default, undefined);

const server = createServer(async (request, response) => {
  const result = await handlerModule.fetch(
    new globalThis.Request(`http://127.0.0.1${request.url}`, { method: request.method }),
  );
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(Buffer.from(await result.arrayBuffer()));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
const health = await globalThis.fetch(`http://127.0.0.1:${address.port}/health`);
const body = await health.json();
await new Promise((resolveClose, rejectClose) =>
  server.close((error) => (error ? rejectClose(error) : resolveClose(undefined))),
);
assert.equal(health.status, 200);
assert.deepEqual(body, { status: 'ok', environment: 'test', version: '1.0.0' });

process.stdout.write(
  `Vercel output smoke passed: one compiled Node 24 function and HTTP GET /health -> ${health.status} ${JSON.stringify(body)}.\n`,
);
