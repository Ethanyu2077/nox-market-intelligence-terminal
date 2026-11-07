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

/** GET with one re-authentication retry on 401; 403 is never retried. */
export async function authorizedGet(base, path, credentials, fetchImpl = fetch) {
  if (!credentials?.ok) return { ok: false, status: 0, reason: credentials?.reason ?? 'missing admin credentials' };
  const attempt = async () => {
    const session = await login(base, credentials, fetchImpl);
    if (!session.ok) return { ok: false, status: session.status, reason: session.reason, retryable: session.status === 401 };
    const response = await fetchImpl(`${base}${path}`, { headers: { cookie: session.cookie } });
    return { ok: response.ok, status: response.status, response, retryable: response.status === 401 };
  };
  let result = await attempt();
  if (result.status === 401) result = await attempt();
  if (result.ok) return { ok: true, status: result.status, data: await result.response.json() };
  if (result.status === 403) return { ok: false, status: 403, reason: 'admin role required' };
  if (result.status === 401) return { ok: false, status: 401, reason: 'admin session rejected after one retry' };
  return { ok: false, status: result.status ?? 0, reason: result.reason ?? `HTTP ${result.status}` };
}

/** Reuses one admin cookie for a whole acceptance run; 401 re-auths once, 403 stops. */
export function createSessionClient(base, credentials, fetchImpl = fetch) {
  let cookie = null;
  const reset = () => { cookie = null; };
  const ensure = async () => {
    if (cookie) return { ok: true, cookie };
    if (!credentials?.ok) return { ok: false, status: 0, reason: credentials?.reason ?? 'missing admin credentials' };
    const session = await login(base, credentials, fetchImpl);
    if (session.ok) { cookie = session.cookie; return session; }
    return session;
  };
  const get = async (path) => {
    let session = await ensure();
    if (!session.ok) return { ok: false, status: session.status ?? 0, reason: session.reason };
    let response = await fetchImpl(`${base}${path}`, { headers: { cookie: session.cookie } });
    if (response.status === 401) {
      reset();
      session = await ensure();
      if (!session.ok) return { ok: false, status: 401, reason: 're-authentication failed after 401' };
      response = await fetchImpl(`${base}${path}`, { headers: { cookie: session.cookie } });
      if (response.status === 401) return { ok: false, status: 401, reason: 'admin session rejected after one retry' };
    }
    if (response.status === 403) return { ok: false, status: 403, reason: 'admin role required' };
    if (!response.ok) return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
    return { ok: true, status: response.status, data: await response.json() };
  };
  return { get, reset };
}
