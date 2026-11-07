import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error plain ESM module used by acceptance scripts
import { evaluateRestart } from '../scripts/acceptance/lib/restart.mjs';

const base = {
  restartAuthorized: true, restartOk: true, identityBefore: 'boot-a', identityAfter: 'boot-b',
  readyAfter: true, apiReadAvailable: true, idsBefore: ['a', 'b'], idsAfter: ['b', 'a'],
};

test('full restart recovery passes', () => {
  assert.equal(evaluateRestart(base).status, 'PASS');
});

test('a successful command without an identity change is not a restart', () => {
  const result = evaluateRestart({ ...base, identityAfter: 'boot-a' });
  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, /identity did not change/);
});

test('a failed restart command fails', () => {
  assert.equal(evaluateRestart({ ...base, restartOk: false }).status, 'FAIL');
});

test('an API that never becomes ready fails', () => {
  assert.equal(evaluateRestart({ ...base, readyAfter: false }).status, 'FAIL');
});

test('missing records after restart fail', () => {
  assert.equal(evaluateRestart({ ...base, idsAfter: ['a'] }).status, 'FAIL');
});

test('duplicate records after restart fail', () => {
  assert.equal(evaluateRestart({ ...base, idsAfter: ['a', 'b', 'a'] }).status, 'FAIL');
});

test('connection-only recovery without restart authorization is NOT VERIFIED', () => {
  assert.equal(evaluateRestart({ ...base, restartAuthorized: false }).status, 'NOT VERIFIED');
});

test('restart without an API read path is NOT VERIFIED, not PASS', () => {
  const result = evaluateRestart({ ...base, apiReadAvailable: false });
  assert.equal(result.status, 'NOT VERIFIED');
  assert.match(result.reason, /restarted API/);
});
