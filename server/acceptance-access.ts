/** Acceptance-only access rules. Kept pure so they can be regression-tested. */
export const ACCEPTANCE_SOURCE = /^acceptance:[a-zA-Z0-9_-]{1,64}$/;

export interface AcceptanceEnv { NOX_ACCEPTANCE_MODE?: string; NODE_ENV?: string }

/** Enabled only by an explicit flag AND a non-production environment. */
export function acceptanceRouteEnabled(env: AcceptanceEnv = process.env as AcceptanceEnv): boolean {
  return env.NOX_ACCEPTANCE_MODE === '1' && env.NODE_ENV !== 'production';
}

export type AcceptanceDecision = { ok: boolean; status?: 400 | 401 | 403; reason?: string };

export function authorizeAcceptance(user: { role?: string } | null, source: unknown): AcceptanceDecision {
  if (!user) return { ok: false, status: 401, reason: 'Sign in required' };
  if (user.role !== 'admin') return { ok: false, status: 403, reason: 'Admin role required' };
  if (typeof source !== 'string' || !ACCEPTANCE_SOURCE.test(source)) return { ok: false, status: 400, reason: 'Invalid acceptance source' };
  return { ok: true };
}
