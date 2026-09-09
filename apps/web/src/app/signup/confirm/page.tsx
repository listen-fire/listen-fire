"use client";

/**
 * Password-signup confirmation landing. A user clicks the magic link we emailed
 * during password signup (`/signup/confirm?token=…`), we POST the single-use
 * token to the API, which provisions the account + sets the session cookie, and
 * we drop them into the app. Mirrors the OAuth callback landings.
 */

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Phase = "confirming" | "error";

function ConfirmForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("confirming");

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setPhase("error");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/public/auth/password/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        if (!res.ok) {
          setPhase("error");
          return;
        }
        const data = await res.json().catch(() => ({}));
        router.replace(
          data.email ? `/home?email=${encodeURIComponent(data.email)}` : "/home",
        );
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
        <div className="w-full max-w-sm space-y-4" data-testid="confirm-error">
          <h1 className="text-xl font-bold">This link is invalid or expired</h1>
          <p className="text-sm text-gray-500">
            The confirmation link may have already been used or timed out.
          </p>
          <a
            href="/login?mode=signup"
            className="inline-block w-full rounded bg-black px-4 py-2 text-center text-sm font-medium text-white hover:bg-gray-800"
            data-testid="confirm-request-new"
          >
            Request a new link
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <p className="text-sm text-gray-500" data-testid="confirm-loading">
        Confirming your account…
      </p>
    </main>
  );
}

export default function ConfirmPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center px-4">
          <p className="text-sm text-gray-500">Loading…</p>
        </main>
      }
    >
      <ConfirmForm />
    </Suspense>
  );
}
