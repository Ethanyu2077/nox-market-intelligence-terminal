import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceRouteEnabled, authorizeAcceptance } from '../server/acceptance-access.ts';

test('the route is absent unless explicitly enabled outside production', () => {
  assert.equal(acceptanceRouteEnabled({}), false);
  assert.equal(acceptanceRouteEnabled({ NOX_ACCEPTANCE_MODE: '1' }), true);
  assert.equal(acceptanceRouteEnabled({ NOX_ACCEPTANCE_MODE: '1', NODE_ENV: 'test' }), true);
  assert.equal(acceptanceRouteEnabled({ NOX_ACCEPTANCE_MODE: '1', NODE_ENV: 'production' }), false, 'production can never enable it');
  assert.equal(acceptanceRouteEnabled({ NOX_ACCEPTANCE_MODE: 'true' }), false);
});

test('unauthenticated access is rejected', () => {
  assert.equal(authorizeAcceptance(null, 'acceptance:ns1').status, 401);
});

test('non-admin users are rejected', () => {
  assert.equal(authorizeAcceptance({ role: 'analyst' }, 'acceptance:ns1').status, 403);
  assert.equal(authorizeAcceptance({ role: 'viewer' }, 'acceptance:ns1').status, 403);
});

test('admins can read an acceptance namespace', () => {
  assert.deepEqual(authorizeAcceptance({ role: 'admin' }, 'acceptance:ns1'), { ok: true });
});

test('non-acceptance namespaces are rejected', () => {
  assert.equal(authorizeAcceptance({ role: 'admin' }, 'proj-dood').status, 400);
  assert.equal(authorizeAcceptance({ role: 'admin' }, 'acceptance:../prod').status, 400);
  assert.equal(authorizeAcceptance({ role: 'admin' }, 'acceptance:').status, 400);
});

test('oversized or malformed sources are rejected', () => {
  assert.equal(authorizeAcceptance({ role: 'admin' }, `acceptance:${'a'.repeat(65)}`).status, 400);
  assert.equal(authorizeAcceptance({ role: 'admin' }, 42).status, 400);
});
