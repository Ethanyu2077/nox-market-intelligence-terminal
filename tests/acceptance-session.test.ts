import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error plain ESM helper used by the acceptance script
import { authorizedGet, credentialsFromEnv, login } from '../scripts/acceptance/lib/api-session.mjs';

const respond = (status: number, body: unknown = {}, cookie?: string) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { getSetCookie: () => cookie ? [cookie] : [], get: () => cookie ?? null },
  json: async () => body,
});

test('missing admin credentials are refused without echoing values', () => {
  const missing = credentialsFromEnv({});
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /ACCEPTANCE_ADMIN_USER/);
  const noPassword = credentialsFromEnv({ ACCEPTANCE_ADMIN_USER: 'ops' });
  assert.match(noPassword.reason, /ACCEPTANCE_ADMIN_PASSWORD/);
  assert.equal(credentialsFromEnv({ ACCEPTANCE_ADMIN_USER: ' ops ', ACCEPTANCE_ADMIN_PASSWORD: 'secret' }).ok, true);
});

test('wrong credentials are rejected', async () => {
  const result = await login('http://api', { user: 'ops', password: 'nope' }, async () => respond(401));
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.reason, 'invalid credentials');
});

test('a non-permitted account is rejected', async () => {
  const result = await login('http://api', { user: 'viewer', password: 'x' }, async () => respond(403));
  assert.equal(result.status, 403);
});

test('admin login returns a session cookie and role without the password', async () => {
  const result = await login('http://api', { user: 'ops', password: 'secret' }, async () => respond(200, { user: { role: 'admin' } }, 'nox_session=abc; Path=/; HttpOnly'));
  assert.equal(result.ok, true);
  assert.equal(result.cookie, 'nox_session=abc');
  assert.equal(result.role, 'admin');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('a missing session cookie is not a successful login', async () => {
  const result = await login('http://api', { user: 'ops', password: 'secret' }, async () => respond(200, { user: { role: 'admin' } }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /session cookie/);
});

test('an expired session can be re-established with a fresh login', async () => {
  const expired = await login('http://api', { user: 'ops', password: 'secret' }, async () => respond(401));
  assert.equal(expired.ok, false);
  const renewed = await login('http://api', { user: 'ops', password: 'secret' }, async () => respond(200, { user: { role: 'admin' } }, 'nox_session=new; Path=/'));
  assert.equal(renewed.ok, true);
  assert.equal(renewed.cookie, 'nox_session=new');
});

test('a 401 triggers exactly one re-authentication and retry', async () => {
  let calls = 0;
  const fake = async (url: string) => {
    calls += 1;
    if (String(url).endsWith('/api/auth/login')) return respond(200, { user: { role: 'admin' } }, `nox_session=s${calls}; Path=/`);
    return calls === 2 ? respond(401) : respond(200, { items: [] });
  };
  const result = await authorizedGet('http://api', '/api/acceptance/records', { ok: true, user: 'ops', password: 'x' }, fake as never);
  assert.equal(result.ok, true);
  assert.equal(calls, 4, 'login + request + login + retry');
});

test('a persistent 401 after the retry is NOT VERIFIED', async () => {
  const fake = async (url: string) => String(url).endsWith('/api/auth/login')
    ? respond(200, { user: { role: 'admin' } }, 'nox_session=a; Path=/')
    : respond(401);
  const result = await authorizedGet('http://api', '/x', { ok: true, user: 'ops', password: 'x' }, fake as never);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.reason, /retry/);
});

test('403 is not retried', async () => {
  let calls = 0;
  const fake = async (url: string) => {
    calls += 1;
    if (String(url).endsWith('/api/auth/login')) return respond(200, { user: { role: 'admin' } }, 'nox_session=a; Path=/');
    return respond(403);
  };
  const result = await authorizedGet('http://api', '/x', { ok: true, user: 'ops', password: 'x' }, fake as never);
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(calls, 2, 'login + request only');
});

test('missing credentials never reach the network', async () => {
  let calls = 0;
  const result = await authorizedGet('http://api', '/x', { ok: false, reason: 'ACCEPTANCE_ADMIN_USER is required' }, (async () => { calls += 1; return respond(200); }) as never);
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});
