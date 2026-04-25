import { useState, useEffect, useCallback } from 'react';

export interface AuthState {
  loading: boolean;
  authenticated: boolean;
  userId: string | null;
  appName: string | null;   // set only when authMode === 'app'
  profile: Record<string, unknown> | null;
  authMode: 'none' | 'app' | 'user';
  mode: 'debug' | 'production';
}

const INITIAL: AuthState = {
  loading: true,
  authenticated: false,
  userId: null,
  appName: null,
  profile: null,
  authMode: 'none',
  mode: 'debug',
};

export function useAuth() {
  const [state, setState] = useState<AuthState>(INITIAL);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setState({
          loading: false,
          authenticated: true,
          userId: data.userId,
          appName: data.appName ?? null,
          profile: data.profile ?? null,
          authMode: data.authMode,
          mode: data.mode,
        });
      } else {
        const data = await res.json().catch(() => ({}));
        setState(s => ({
          ...s,
          loading: false,
          authenticated: false,
          userId: null,
          appName: null,
          profile: null,
          authMode: data.authMode ?? s.authMode,
        }));
      }
    } catch {
      setState(s => ({ ...s, loading: false, authenticated: false }));
    }
  }, []);

  // On mount: check app_token in URL (app-to-app flow), then verify session
  useEffect(() => {
    const url = new URL(window.location.href);
    const appToken = url.searchParams.get('app_token');

    if (appToken) {
      // Exchange one-time token for a session cookie
      fetch(`/api/auth/exchange?app_token=${encodeURIComponent(appToken)}`, { credentials: 'include' })
        .then(() => {
          // Clean token from URL without adding to history
          url.searchParams.delete('app_token');
          window.history.replaceState({}, '', url.toString());
          return refresh();
        })
        .catch(() => refresh());
    } else {
      refresh();
    }
  }, [refresh]);

  const login = useCallback(async (userId: string, password: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, password }),
      });
      if (res.ok) {
        await refresh();
        return null;
      }
      const data = await res.json().catch(() => ({}));
      return (data.error as string) ?? 'Login failed';
    } catch {
      return 'Network error';
    }
  }, [refresh]);

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setState(s => ({ ...s, authenticated: false, userId: null, profile: null }));
  }, []);

  return { ...state, refresh, login, logout };
}
