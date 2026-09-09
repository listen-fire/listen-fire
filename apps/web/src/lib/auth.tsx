'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

import { useCapabilities } from './capabilities-provider';

const LS_KEY = '__LISTEN_FIRE__';

interface StorageShape {
  users: Array<{ email: string; selectedTeamId?: string }>;
  email?: string;
}

function getStorage(): StorageShape {
  if (typeof window === 'undefined') return { users: [] };
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : { users: [] };
  } catch {
    return { users: [] };
  }
}

function setStorage(patch: Partial<StorageShape>) {
  const storage = getStorage();
  localStorage.setItem(LS_KEY, JSON.stringify({ ...storage, ...patch }));
}

function getTeamId(email: string): string | undefined {
  const storage = getStorage();
  const user = storage.users.find((u) => u.email === email);
  return user?.selectedTeamId;
}

function setTeamIdCookie(teamId: string | undefined) {
  if (teamId) {
    document.cookie = `listen_fire_team_id=${teamId};path=/;max-age=${180 * 24 * 60 * 60}`;
  } else {
    document.cookie = 'listen_fire_team_id=;path=/;max-age=0';
  }
}

interface AuthContextValue {
  email: string | null;
  /** Who to show as signed in. An email under core identity; a static install
   *  has no account to name, so it says what the credential was instead. */
  identityLabel: string | null;
  teamId: string | undefined;
  isAuthenticated: boolean;
  isLoading: boolean;
  logout: () => void;
  switchTeam: (teamId: string) => void;
}

const AuthContext = createContext<AuthContextValue>({
  email: null,
  identityLabel: null,
  teamId: undefined,
  isAuthenticated: false,
  isLoading: true,
  logout: () => {},
  switchTeam: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  // A static install has no account and so no email to remember: the marker
  // cookie IS the session, which is exactly why the API sets a JS-readable one.
  const [hasSessionMarker, setHasSessionMarker] = useState(false);
  const capabilities = useCapabilities();
  const staticIdentity = capabilities?.identity === 'static';

  // Read localStorage after hydration
  useEffect(() => {
    const storage = getStorage();
    // The session cookie `listen_fire_token` is httpOnly (invisible to JS), so we check
    // the JS-readable `listen_fire_authed` presence marker the API sets alongside it.
    const hasAuthCookie = document.cookie
      .split(';')
      .some((c) => c.trim().startsWith('listen_fire_authed='));
    setHasSessionMarker(hasAuthCookie);
    // If localStorage says authenticated but the session marker is gone, clear stale state
    if (storage.email && !hasAuthCookie) {
      setStorage({ email: undefined });
      setMounted(true);
      return;
    }
    setEmail(storage.email ?? null);
    const isImpersonating = !!localStorage.getItem('__LISTEN_FIRE_IMPERSONATE__');
    if (storage.email && !isImpersonating) {
      setTeamIdCookie(getTeamId(storage.email));
    }
    setMounted(true);
  }, []);

  // Accept email from URL params after login (cookie is already set by the API)
  useEffect(() => {
    const urlEmail = searchParams.get('email');
    if (urlEmail) {
      setStorage({ email: urlEmail });
      setEmail(urlEmail);
      setTeamIdCookie(getTeamId(urlEmail));
      const params = new URLSearchParams(searchParams.toString());
      params.delete('email');
      const newUrl = params.toString() ? `?${params.toString()}` : window.location.pathname;
      router.replace(newUrl);
    }
  }, [searchParams, router]);

  const value = useMemo<AuthContextValue>(() => {
    const isImpersonating = typeof window !== 'undefined' && !!localStorage.getItem('__LISTEN_FIRE_IMPERSONATE__');
    const teamId = email && !isImpersonating ? getTeamId(email) : undefined;

    return {
      email,
      identityLabel: staticIdentity ? 'API key' : email,
      teamId,
      isAuthenticated: staticIdentity ? hasSessionMarker : email !== null,
      isLoading: !mounted,
      logout: async () => {
        // A static-identity install has no account session to end — only the
        // cookies the API key bought, which its own route clears.
        const endpoint = staticIdentity
          ? '/api/public/auth/static/logout'
          : '/api/public/auth/logout';
        try {
          await fetch(endpoint, { method: 'POST' });
        } catch {
          // best-effort
        }
        setStorage({ email: undefined });
        setTeamIdCookie(undefined);
        setEmail(null);
        setHasSessionMarker(false);
        router.replace('/login');
      },
      switchTeam: (newTeamId: string) => {
        if (!email) return;
        const storage = getStorage();
        const users = storage.users.filter((u) => u.email !== email);
        users.push({ email, selectedTeamId: newTeamId });
        setStorage({ users });
        setTeamIdCookie(newTeamId);
        window.location.reload();
      },
    };
  }, [email, mounted, router, staticIdentity, hasSessionMarker]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
