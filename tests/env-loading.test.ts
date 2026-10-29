import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv, resolveAllowedOrigins } from '../server/env.ts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('environment file is applied without overriding variables from the real environment', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nox-env-'));
  const file = path.join(directory, '.env');
  await writeFile(file, 'NOX_TEST_ENV_FROM_FILE=file-value\nNOX_TEST_ENV_PRESET=file-value\n');
  const previousFileValue = process.env.NOX_TEST_ENV_FROM_FILE;
  const previousPreset = process.env.NOX_TEST_ENV_PRESET;
  delete process.env.NOX_TEST_ENV_FROM_FILE;
  process.env.NOX_TEST_ENV_PRESET = 'process-value';
  try {
    assert.equal(loadLocalEnv(file), file);
    assert.equal(process.env.NOX_TEST_ENV_FROM_FILE, 'file-value');
    // Shell/npm/CI environment keeps precedence, matching `node --env-file` semantics.
    assert.equal(process.env.NOX_TEST_ENV_PRESET, 'process-value');
  } finally {
    if (previousFileValue == null) delete process.env.NOX_TEST_ENV_FROM_FILE; else process.env.NOX_TEST_ENV_FROM_FILE = previousFileValue;
    if (previousPreset == null) delete process.env.NOX_TEST_ENV_PRESET; else process.env.NOX_TEST_ENV_PRESET = previousPreset;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a missing environment file is an explicit no-op', () => {
  assert.equal(loadLocalEnv(path.join(tmpdir(), `nox-absent-${Date.now()}`, '.env')), null);
});

test('documented Vite development origins are trusted for browser mutations', () => {
  const origins = resolveAllowedOrigins(8787, undefined, true);
  for (const origin of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://127.0.0.1:4173', 'http://localhost:4173', 'http://127.0.0.1:5173']) {
    assert.ok(origins.has(origin), `${origin} must be allowed by default`);
  }
  assert.ok(!origins.has('https://example.invalid'), 'arbitrary origins must not be trusted');
});

test('production does not trust the Vite development origins', () => {
  const origins = resolveAllowedOrigins(8787, undefined, false);
  assert.ok(origins.has('http://127.0.0.1:8787'), 'the API port stays trusted even in production');
  assert.ok(!origins.has('http://127.0.0.1:4173'), 'a local dev server must not act with production credentials');
  assert.ok(!origins.has('http://localhost:5173'));
});

test('the documented launcher applies .env before starting the API', { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nox-launcher-'));
  const port = 22_000 + Math.floor(Math.random() * 10_000);
  const environment = { ...process.env };
  for (const key of ['PORT', 'DATA_DIR', 'NOX_AUTH_DIR', 'NOX_ENV_FILE', 'NOX_ALLOWED_ORIGINS', 'NODE_ENV']) delete environment[key];
  await symlink(path.join(repositoryRoot, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  await writeFile(path.join(directory, '.env'), `PORT=${port}\nDATA_DIR=./data-from-env\nNOX_AUTH_DIR=./auth-from-env\n`);
  const child = spawn(process.execPath, [path.join(repositoryRoot, 'server', 'start.mjs')], { cwd: directory, env: environment });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  try {
    const deadline = Date.now() + 25_000;
    let reachable = false;
    while (Date.now() < deadline) {
      if (output.includes(`listening on http://127.0.0.1:${port}`)) { reachable = true; break; }
      if (child.exitCode != null) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(reachable, `launcher did not use .env PORT=${port}; output: ${output.slice(0, 800)}`);
    // DATA_DIR from .env is applied too: the server must not have created the default .data in the launcher directory.
    const { stat } = await import('node:fs/promises');
    await stat(path.join(directory, 'data-from-env', 'preferences.json'));
    await assert.rejects(stat(path.join(directory, '.data', 'preferences.json')));
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5_000); });
    await rm(directory, { recursive: true, force: true });
  }
});
