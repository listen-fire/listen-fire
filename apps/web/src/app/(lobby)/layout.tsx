'use client';

/**
 * The lobby layout — the authed front door (`/home`). Deliberately
 * chrome-less: no sidebar, no assistant, no app shell. Login lands here;
 * entering the platform proper (`/dashboard`, inside the `(app)` shell) is a
 * deliberate second click.
 *
 * Auth is enforced by middleware (redirects unauthed → /login for any
 * non-public path); this layout only holds the `isLoading` gate so the page
 * doesn't flash before the session resolves. Providers (auth, tRPC) come from
 * the root `app/layout.tsx`.
 */

import { useAuth } from '@/lib/auth';

export default function LobbyLayout({ children }: { children: React.ReactNode }) {
  const { isLoading } = useAuth();

  if (isLoading) {
    return null;
  }

  return <div className="min-h-dvh bg-white">{children}</div>;
}
