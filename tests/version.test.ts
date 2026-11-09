import assert from 'node:assert/strict';
import test from 'node:test';
import { versionInfo } from '../server/version.ts';

test('reports commit, build time and runtime identity', () => {
  const info = versionInfo({ NOX_COMMIT_SHA: '84fae32', NOX_BUILD_TIME: '2026-11-09T12:00:00Z' }, 1000, 'v24.0.0');
  assert.deepEqual(info, { commit: '84fae32', buildTime: '2026-11-09T12:00:00Z', apiVersion: '0.2.0', startedAt: 1000, node: 'v24.0.0' });
});

test('falls back to GIT_COMMIT and rejects non-hash values', () => {
  assert.equal(versionInfo({ GIT_COMMIT: 'abcdef1' }, 1, 'v24').commit, 'abcdef1');
  assert.equal(versionInfo({ NOX_COMMIT_SHA: '/srv/nox; rm -rf /' }, 1, 'v24').commit, 'unknown');
});

test('never leaks unrelated environment values', () => {
  const info = versionInfo({ NOX_COMMIT_SHA: '1234abc', DATABASE_URL: 'postgres://secret', NOX_ACCEPTANCE_MODE: '1' }, 2, 'v24');
  assert.equal(JSON.stringify(info).includes('secret'), false);
  assert.equal(JSON.stringify(info).includes('ACCEPTANCE'), false);
});
