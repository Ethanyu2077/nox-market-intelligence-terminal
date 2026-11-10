import { useCallback, useEffect, useState } from 'react';

export interface AuthUser { name: string; role: 'viewer' | 'analyst' | 'admin'; isSuperAdmin?: boolean }

/** Shared authentication state for the shell. Refreshes on `nox:auth-changed`. */
export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/status', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error();
      const body = await response.json();
      setUser(body.user ?? null);
      setSetupRequired(Boolean(body.setupRequired));
    } catch {
      setUser(null);
    } finally { setReady(true); }
  }, []);

  useEffect(() => {
    void refresh();
    const listener = () => void refresh();
    window.addEventListener('nox:auth-changed', listener);
    return () => window.removeEventListener('nox:auth-changed', listener);
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } finally {
      window.dispatchEvent(new Event('nox:auth-changed'));
      await refresh();
    }
  }, [refresh]);

  return { user, ready, setupRequired, refresh, signOut };
}
