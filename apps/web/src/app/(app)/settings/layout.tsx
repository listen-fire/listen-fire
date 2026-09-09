"use client";

/**
 * Settings shell — deliberately OUTSIDE the platform. `/settings` is registered
 * in the app-shell's HIDDEN_SIDEBAR_PREFIXES, so it renders chrome-less (no
 * sidebar) and is reachable straight from the lobby — the platform is
 * power-users-only, but account settings must not be. Its own header
 * (wordmark → lobby, Back, Sign out) + tab-nav stand in for the missing sidebar.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, LogOut } from "lucide-react";

import { useAuth } from "@/lib/auth";

const tabs = [
  { label: "General", href: "/settings" },
  { label: "Team", href: "/settings/team" },
  { label: "API Keys", href: "/settings/api-keys" },
  { label: "Webhooks", href: "/settings/webhooks" },
  { label: "Remote Adapters", href: "/settings/remote-adapters" },
] as const;

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { logout } = useAuth();

  return (
    <div className="flex h-full flex-col bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3.5">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 text-[13px] font-medium text-slate-500 transition-colors hover:text-slate-900"
          >
            <ArrowLeft size={15} />
            Back
          </button>
          <Link
            href="/home"
            className="text-lg font-bold uppercase tracking-[0.2em] text-primary"
          >
            Listen-Fire
          </Link>
        </div>
        <button
          onClick={logout}
          className="flex items-center gap-1.5 text-[13px] font-medium text-slate-500 transition-colors hover:text-slate-900"
        >
          <LogOut size={14} />
          Sign out
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-6 pb-16 pt-8">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            Settings
          </h1>
          <nav className="mt-5 flex gap-4 overflow-x-auto border-b border-slate-200">
            {tabs.map((tab) => {
              const active =
                tab.href === "/settings"
                  ? pathname === "/settings"
                  : pathname.startsWith(tab.href);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={`shrink-0 whitespace-nowrap border-b-2 px-1 pb-2 text-[13px] font-medium transition-colors ${
                    active
                      ? "border-primary text-primary-700"
                      : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
          </nav>
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
