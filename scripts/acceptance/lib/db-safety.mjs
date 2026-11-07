/** Decides whether writes are allowed, based on the CONNECTED database identity. */
export function isWritableDatabase({ allowWrites, expectedName, actualName }) {
  if (allowWrites !== true) return { ok: false, reason: 'ACCEPTANCE_ALLOW_WRITES=1 is required' };
  if (!expectedName) return { ok: false, reason: 'ACCEPTANCE_TEST_DB_NAME is required to confirm the database identity' };
  if (!actualName) return { ok: false, reason: 'connected database identity could not be confirmed' };
  if (actualName !== expectedName) return { ok: false, reason: `connected database is not the declared test database` };
  if (!/test|acceptance|tmp|ci/i.test(actualName)) return { ok: false, reason: 'database name is not disposable-test-like' };
  return { ok: true, reason: null };
}
