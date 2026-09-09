'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

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
  teamId: string | undefined;
  isAuthenticated: boolean;
  isLoading: boolean;
  logout: () => void;
  switchTeam: (teamId: string) => void;
}

const AuthContext = createContext<AuthContextValue>({
  email: null,
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

  // Read localStorage after hydration.
  // NOTE: the listen_fire_token session cookie is httpOnly, so it is invisible to
  // document.cookie. We must NOT gate auth state on reading it — doing so always
  // failed and wiped a valid session immediately after login. We trust the
  // persisted email; the server validates the httpOnly cookie on every request
  // and returns 401 if it's missing/expired.
  useEffect(() => {
    const storage = getStorage();
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
      teamId,
      isAuthenticated: email !== null,
      isLoading: !mounted,
      logout: async () => {
        try {
          await fetch('/api/public/auth/logout', { method: 'POST' });
        } catch {
          // best-effort
        }
        setStorage({ email: undefined });
        setTeamIdCookie(undefined);
        setEmail(null);
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
  }, [email, mounted, router]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
