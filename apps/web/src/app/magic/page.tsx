"use client";

/**
 * `/magic?token=…` — where a passwordless login email lands. Public (middleware
 * whitelists it): the whole point is that the visitor has no session yet.
 *
 * We POST the single-use token to the API, which verifies it, expires it, and
 * sets the session cookie + its readable presence marker. Then we drop the user
 * into the app. Mirrors the password-signup confirmation landing.
 *
 * Two traps worth naming:
 *
 *   • The verify endpoint answers 200 with `{error}` on a bad token — it does
 *     NOT use a 4xx. Success is `data.token` being present, never `res.ok`.
 *   • Only the EMAIL rides onward in the URL (the auth provider reads it to
 *     name the session). The credential itself stays in the httpOnly cookie;
 *     a JWT in a query string would leak through history and referrers.
 */

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Phase = "verifying" | "error";

/**
 * Where to land after a good token. Billing notices mint an ABSOLUTE
 * `redirectUrl` on this origin, so accept same-origin absolutes (reduced to a
 * path) and same-origin relatives; anything else is an open-redirect attempt
 * and falls back to the app home.
 */
function safeRedirectPath(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw);
    if (url.origin !== window.location.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function withEmail(path: string, email: string | undefined): string {
  if (!email) return path;
  const [base, hash] = path.split("#");
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}email=${encodeURIComponent(email)}${hash ? `#${hash}` : ""}`;
}

function MagicLanding() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("verifying");

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setPhase("error");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/public/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        const data = res.ok ? await res.json().catch(() => ({})) : {};
        if (!data.token) {
          setPhase("error");
          return;
        }

        const redirect = safeRedirectPath(searchParams.get("redirectUrl"));
        // A redirect target may be a rewritten non-Next path, which the client
        // router can't resolve — so honour it with a full page load and keep
        // the in-app default on the router.
        if (redirect) {
          window.location.replace(withEmail(redirect, data.email));
          return;
        }
        router.replace(withEmail("/home", data.email));
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams, router]);

  if (phase === "error") {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-4" data-testid="magic-error">
          <h1 className="text-xl font-bold">This sign-in link is invalid or expired</h1>
          <p className="text-sm text-gray-500">
            Sign-in links work once and time out after a while. Sign in again to get a
            fresh one.
          </p>
          <a
            href="/login"
            className="inline-block w-full rounded bg-black px-4 py-2 text-center text-sm font-medium text-white hover:bg-gray-800"
            data-testid="magic-request-new"
          >
            Go to sign in
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <p className="text-sm text-gray-500" data-testid="magic-loading">
        Signing you in…
      </p>
    </main>
  );
}

export default function MagicPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center px-4">
          <p className="text-sm text-gray-500">Loading…</p>
        </main>
      }
    >
      <MagicLanding />
    </Suspense>
  );
}
