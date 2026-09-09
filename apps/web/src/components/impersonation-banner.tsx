"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";

const NEUTRAL_PATH = "/model";

function redirectToNeutral() {
  if (window.location.pathname === NEUTRAL_PATH) {
    window.location.reload();
  } else {
    window.location.href = NEUTRAL_PATH;
  }
}

export function ImpersonationBanner() {
  const [impersonating, setImpersonating] = useState<{
    userId: string;
    username: string;
  } | null>(null);
  const [mounted, setMounted] = useState(false);
  const [search, setSearch] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Only query user context when not impersonating (so we get the real admin user)
  const { data: me } = trpc.models.user.context.useQuery(undefined, {
    enabled: mounted && !impersonating,
  });

  const { data: results } =
    trpc.views.admin.authenticateAs.usersByEmailPrefix.useQuery(
      { emailPrefix: search },
      { enabled: search.length >= 2 && isOpen && !impersonating },
    );

  // Read impersonation state from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem("__LISTEN_FIRE_IMPERSONATE__");
    if (stored) {
      try {
        setImpersonating(JSON.parse(stored));
      } catch {
        localStorage.removeItem("__LISTEN_FIRE_IMPERSONATE__");
      }
    }
    setMounted(true);
  }, []);

  const startImpersonating = useCallback(
    async (userId: string) => {
      const res = await fetch("/api/auth/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { userId: string; username: string };
      const state = { userId: data.userId, username: data.username };
      localStorage.setItem("__LISTEN_FIRE_IMPERSONATE__", JSON.stringify(state));
      document.cookie = "listen_fire_team_id=;path=/;max-age=0";
      setIsOpen(false);
      setSearch("");
      redirectToNeutral();
    },
    [],
  );

  const stopImpersonating = useCallback(async () => {
    await fetch("/api/auth/stop-impersonate", {
      method: "POST",
      credentials: "include",
    });
    localStorage.removeItem("__LISTEN_FIRE_IMPERSONATE__");
    document.cookie = "listen_fire_team_id=;path=/;max-age=0";
    redirectToNeutral();
  }, []);

  if (!impersonating && !me?.isPlatformAdmin) return null;

  if (impersonating) {
    return (
      <div className="flex h-8 shrink-0 items-center justify-center gap-3 bg-amber-400 text-[12px] font-medium text-amber-950">
        <span>
          Viewing as <strong>{impersonating.username}</strong>
        </span>
        <button
          onClick={stopImpersonating}
          className="rounded bg-amber-950/10 px-2 py-0.5 hover:bg-amber-950/20"
        >
          Stop
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex h-8 shrink-0 items-center justify-center bg-gray-100 text-[12px] text-gray-500">
      {isOpen ? (
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by email or name..."
            className="w-64 rounded border border-gray-300 bg-white px-2 py-0.5 text-[12px] focus:border-gray-400 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setIsOpen(false);
                setSearch("");
              }
            }}
          />
          <button
            onClick={() => {
              setIsOpen(false);
              setSearch("");
            }}
            className="text-gray-400 hover:text-gray-600"
          >
            Cancel
          </button>
          {results && results.length > 0 && (
            <div className="absolute top-8 left-1/2 z-50 max-h-60 w-80 -translate-x-1/2 overflow-auto rounded-md border border-gray-200 bg-white shadow-lg">
              {results.map((user) => (
                <button
                  key={user.id}
                  onClick={() => startImpersonating(user.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-gray-50"
                >
                  <span className="font-medium text-gray-900">
                    {user.name ?? user.email}
                  </span>
                  {user.name && (
                    <span className="text-gray-400">{user.email}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button
          onClick={() => setIsOpen(true)}
          className="text-gray-400 hover:text-gray-600"
        >
          Impersonate user...
        </button>
      )}
    </div>
  );
}
