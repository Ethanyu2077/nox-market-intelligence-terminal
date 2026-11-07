/** Admin session for the acceptance API. Credentials come only from the environment and
 *  are never logged or embedded in reasons. */
export function credentialsFromEnv(env = process.env) {
  const user = env.ACCEPTANCE_ADMIN_USER?.trim();
  const password = env.ACCEPTANCE_ADMIN_PASSWORD;
  if (!user) return { ok: false, reason: 'ACCEPTANCE_ADMIN_USER is required' };
  if (!password) return { ok: false, reason: 'ACCEPTANCE_ADMIN_PASSWORD is required' };
  return { ok: true, user, password };
}

export async function login(base, credentials, fetchImpl = fetch) {
  if (!credentials?.user || !credentials?.password) return { ok: false, status: 0, reason: 'missing credentials' };
  let response;
  try {
    response = await fetchImpl(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: credentials.user, password: credentials.password }),
    });
  } catch { return { ok: false, status: 0, reason: 'login request failed' }; }
  if (response.status === 401) return { ok: false, status: 401, reason: 'invalid credentials' };
  if (response.status === 403) return { ok: false, status: 403, reason: 'account is not permitted' };
  if (!response.ok) return { ok: false, status: response.status, reason: `login failed (HTTP ${response.status})` };
  const raw = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
  if (!raw) return { ok: false, status: response.status, reason: 'no session cookie returned' };
  let role = null;
  try { role = (await response.json())?.user?.role ?? null; } catch { /* body optional */ }
  return { ok: true, cookie: raw.split(';')[0], role };
}
