import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error plain ESM helper used by the acceptance script
import { credentialsFromEnv, login } from '../scripts/acceptance/lib/api-session.mjs';

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
