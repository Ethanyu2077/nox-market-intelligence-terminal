// Single browser API client for NOX.
//
// It tolerates empty bodies (204 No Content from DELETE) and non-JSON upstream failures:
// the previous implementation always called response.json(), so a successful project
// deletion threw a SyntaxError before the UI could refresh.
export const API_BASE = '/api';
export const AUTH_REQUIRED_EVENT = 'nox:auth-required';

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const text = await response.text();
  let body: unknown;
  if (text) {
    try { body = JSON.parse(text); }
    catch { throw new Error(`Unreadable response from ${path} (HTTP ${response.status})`); }
  }
  if (!response.ok) {
    const message = (body as { error?: { message?: string } } | null)?.error?.message ?? `Request failed (HTTP ${response.status})`;
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    throw new Error(message);
  }
  return body as T;
}
