'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { GoogleOAuthProvider, GoogleLogin } from '@react-oauth/google';

const LS_KEY = '__LISTEN_FIRE__';

const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';

// Only allow same-origin paths to prevent open-redirect via ?returnUrl=...
function safeReturnUrl(raw: string | null): string | null {
  if (!raw) return null;
  // Reject absolute, protocol-relative ("//"), and backslash forms ("/\evil.com",
  // which some browsers normalize to "//"). Only a clean in-app path is allowed.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  return raw;
}

// Persist the session the same way the admin AuthProvider reads it: it derives
// `email` (and therefore `isAuthenticated`) from the `email` field on the
// `__LISTEN_FIRE__` localStorage object. The `listen_fire_token` cookie is set by the API.
function persistSession(email: string) {
  let storage: { users?: unknown[]; email?: string } = { users: [] };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) storage = JSON.parse(raw);
  } catch {
    // start fresh
  }
  localStorage.setItem(LS_KEY, JSON.stringify({ ...storage, email }));
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnUrl = safeReturnUrl(searchParams.get('returnUrl'));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-gray-100 bg-white p-8 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Listen-Fire Admin</h1>
          <p className="mt-1 text-sm text-gray-500">
            Sign in with your platform admin account.
          </p>
        </div>

        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}

        {loading ? (
          <p className="text-sm text-gray-500">Signing in…</p>
        ) : (
          <div className="flex justify-center">
            <GoogleLogin
              width={336}
              onSuccess={async (credentialResponse) => {
                if (!credentialResponse.credential) {
                  setError('No credential received from Google.');
                  return;
                }

                setLoading(true);
                setError(null);

                try {
                  const res = await fetch(
                    '/api/public/auth/google/admin/callback',
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        idToken: credentialResponse.credential,
                      }),
                    },
                  );

                  if (res.status === 403) {
                    setError(
                      "Admin access required — this account isn't a platform admin.",
                    );
                    setLoading(false);
                    return;
                  }

                  if (!res.ok) {
                    const text = await res.text();
                    setError(text || 'Authentication failed.');
                    setLoading(false);
                    return;
                  }

                  const data = await res.json();
                  if (data.email) {
                    persistSession(data.email);
                    router.replace(returnUrl ?? '/feed');
                  } else {
                    setError('Unexpected response from server.');
                    setLoading(false);
                  }
                } catch {
                  setError('Failed to authenticate. Is the API running?');
                  setLoading(false);
                }
              }}
              onError={() => {
                setError('Google sign-in failed.');
              }}
            />
          </div>
        )}
      </div>
    </main>
  );
}

export default function LoginPage() {
  if (!googleClientId) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-4">
        <p className="text-sm text-red-600">
          No sign-in provider configured. Set NEXT_PUBLIC_GOOGLE_CLIENT_ID.
        </p>
      </main>
    );
  }

  return (
    <GoogleOAuthProvider clientId={googleClientId}>
      <LoginForm />
    </GoogleOAuthProvider>
  );
}
