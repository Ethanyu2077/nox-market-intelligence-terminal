import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { apiNotFound } from '../server/api-not-found.ts';

async function withApi(run: (base: string) => Promise<void>) {
  const app = express();
  app.get('/api/known', (_req, res) => { res.json({ ok: true }); });
  app.use('/api', apiNotFound);
  app.get('*', (_req, res) => { res.type('html').send('<html>spa</html>'); });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try { await run(`http://127.0.0.1:${port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('unknown API routes return JSON 404, never the SPA HTML', async () => {
  await withApi(async (base) => {
    const response = await fetch(`${base}/api/projects/x/research/jobs`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'API_NOT_FOUND');
  });
});

test('known API routes are unaffected and non-API paths still serve the SPA', async () => {
  await withApi(async (base) => {
    assert.equal((await fetch(`${base}/api/known`)).status, 200);
    const spa = await fetch(`${base}/dashboard`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /spa/);
  });
});
