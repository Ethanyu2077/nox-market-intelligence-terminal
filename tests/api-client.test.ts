import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../src/api.ts';

const withFetch = async (replacement: typeof fetch, run: () => Promise<void>) => {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try { await run(); } finally { globalThis.fetch = original; }
};

test('204 No Content resolves without throwing (project deletion path)', async () => {
  await withFetch((async () => new Response(null, { status: 204 })) as typeof fetch, async () => {
    const value = await api('/projects/example', { method: 'DELETE' });
    assert.equal(value, undefined);
  });
});

test('upstream error bodies keep the server message', async () => {
  await withFetch((async () => new Response(JSON.stringify({ error: { message: 'Origin not allowed' } }), { status: 403, headers: { 'Content-Type': 'application/json' } })) as typeof fetch, async () => {
    await assert.rejects(() => api('/projects', { method: 'POST', body: '{}' }), /Origin not allowed/);
  });
});

test('empty error responses are reported instead of crashing on JSON.parse', async () => {
  await withFetch((async () => new Response(null, { status: 502 })) as typeof fetch, async () => {
    await assert.rejects(() => api('/projects/example/venues'), /HTTP 502/);
  });
});

test('non-JSON success bodies raise an explicit error instead of a SyntaxError', async () => {
  await withFetch((async () => new Response('<html>proxy error</html>', { status: 200 })) as typeof fetch, async () => {
    await assert.rejects(() => api('/projects'), /Unreadable response/);
  });
});
