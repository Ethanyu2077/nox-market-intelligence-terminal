import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { acceptanceRouteEnabled, authorizeAcceptance } from '../server/acceptance-access.ts';
import { registerAcceptanceRoute } from '../server/acceptance-route.ts';

test('environment whitelist is exact', () => {
  assert.equal(acceptanceRouteEnabled({}), false);
  assert.equal(acceptanceRouteEnabled({ NOX_ACCEPTANCE_MODE: '1' }), false, 'missing NODE_ENV must not enable');
  assert.equal(acceptanceRouteEnabled({ NOX_ACCEPTANCE_MODE: '1', NODE_ENV: 'development' }), false);
  assert.equal(acceptanceRouteEnabled({ NOX_ACCEPTANCE_MODE: '1', NODE_ENV: 'production' }), false);
  assert.equal(acceptanceRouteEnabled({ NOX_ACCEPTANCE_MODE: '1', NODE_ENV: 'test' }), true);
});

test('authorization rules', () => {
  assert.equal(authorizeAcceptance(null, 'acceptance:ns1').status, 401);
  assert.equal(authorizeAcceptance({ role: 'viewer' }, 'acceptance:ns1').status, 403);
  assert.equal(authorizeAcceptance({ role: 'analyst' }, 'acceptance:ns1').status, 403);
  assert.deepEqual(authorizeAcceptance({ role: 'admin' }, 'acceptance:ns1'), { ok: true });
  assert.equal(authorizeAcceptance({ role: 'admin' }, 'proj-dood').status, 400);
});

async function withApp(env: Record<string, string | undefined>, run: (url: string, calls: string[]) => Promise<void>) {
  const app = express();
  const calls: string[] = [];
  registerAcceptanceRoute(app, {
    enabled: acceptanceRouteEnabled(env),
    user: (req) => { const role = req.headers['x-role']; return typeof role === 'string' ? { role } : null; },
    page: async (projectId, query) => { calls.push(`${projectId}:${query.source}`); return { items: [{ id: 'a', eventTime: 1, ingestTime: 2, payload: { price: 100 } }] }; },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try { await run(`http://127.0.0.1:${port}/api/acceptance/records?source=acceptance:ns1`, calls); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const mode = { NOX_ACCEPTANCE_MODE: '1', NODE_ENV: 'test' };

test('route is absent by default, without NODE_ENV, in development and production', async () => {
  for (const env of [{}, { NOX_ACCEPTANCE_MODE: '1' }, { NOX_ACCEPTANCE_MODE: '1', NODE_ENV: 'development' }, { NOX_ACCEPTANCE_MODE: '1', NODE_ENV: 'production' }]) {
    await withApp(env, async (url) => {
      const response = await fetch(url, { headers: { 'x-role': 'admin' } });
      assert.equal(response.status, 404);
    });
  }
});

test('test mode registers the route but requires an admin', async () => {
  await withApp(mode, async (url) => {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { 'x-role': 'viewer' } })).status, 403);
    assert.equal((await fetch(url, { headers: { 'x-role': 'analyst' } })).status, 403);
    const ok = await fetch(url, { headers: { 'x-role': 'admin' } });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json() as { items: unknown[] }).items.length, 1);
  });
});

test('admin stays inside the acceptance namespace', async () => {
  await withApp(mode, async (url, calls) => {
    const bad = await fetch(url.replace('acceptance:ns1', 'proj-dood'), { headers: { 'x-role': 'admin' } });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(url, { headers: { 'x-role': 'admin' } })).status, 200);
    assert.deepEqual(calls, ['acceptance:acceptance:ns1'], 'only the acceptance project is queried');
  });
});
