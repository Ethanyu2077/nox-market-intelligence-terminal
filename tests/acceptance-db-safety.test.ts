import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error plain ESM helper used by the acceptance script
import { isWritableDatabase } from '../scripts/acceptance/lib/db-safety.mjs';

test('requires the explicit write flag', () => {
  assert.equal(isWritableDatabase({ allowWrites: false, expectedName: 'nox_test', actualName: 'nox_test' }).ok, false);
});

test('requires a declared test database name', () => {
  assert.match(isWritableDatabase({ allowWrites: true, expectedName: undefined, actualName: 'nox_test' }).reason, /ACCEPTANCE_TEST_DB_NAME/);
});

test('rejects a database that is not the declared one', () => {
  assert.match(isWritableDatabase({ allowWrites: true, expectedName: 'nox_test', actualName: 'nox_prod' }).reason, /declared test database/);
});

test('rejects a production-looking name even if declared', () => {
  assert.equal(isWritableDatabase({ allowWrites: true, expectedName: 'nox_prod', actualName: 'nox_prod' }).ok, false);
});

test('accepts a confirmed disposable test database', () => {
  assert.deepEqual(isWritableDatabase({ allowWrites: true, expectedName: 'nox_acceptance', actualName: 'nox_acceptance' }), { ok: true, reason: null });
});
