"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { useIsMobile } from "@/lib/use-is-mobile";
import { Sidebar } from "./sidebar";
import { AssistantPanel, AssistantProvider } from "./assistant";
import { PageContextProvider } from "./page-context";

/**
 * Routes that mount their own focused shell and should NOT show the
 * sidebar. Empty today: the onboarding funnel now renders inline on Home
 * with the nav visible (it's a real product, not a walled demo). Add a
 * prefix here if a future focused arc needs its own chrome-less shell;
 * matching is exact prefix.
 */
const HIDDEN_SIDEBAR_PREFIXES = ['/settings'] as const;

function shouldHideSidebar(pathname: string | null): boolean {
  if (!pathname) return false;
  return HIDDEN_SIDEBAR_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(false);

  // Default collapsed on mobile
  useEffect(() => {
    setCollapsed(isMobile);
  }, [isMobile]);

  // Close sidebar on navigation (mobile)
  useEffect(() => {
    if (isMobile) setCollapsed(true);
  }, [pathname, isMobile]);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  // Cmd+K is handled by GlobalSearch (opens search modal)

  const hideSidebar = shouldHideSidebar(pathname);

  // AssistantProvider wraps BOTH layouts so the shared overlay state
  // survives a navigation between them — e.g. /setup (sidebar hidden)
  // opens the assistant conversation and hands off to Home (sidebar
  // shown). The hidden-sidebar layout still mounts no chrome; it just
  // lives inside the same provider tree.
  if (hideSidebar) {
    return (
      <PageContextProvider>
        <AssistantProvider>
          <div className="flex h-full">
            <main className="flex flex-1 flex-col overflow-hidden bg-white">
              {children}
            </main>
          </div>
        </AssistantProvider>
      </PageContextProvider>
    );
  }

  return (
    <PageContextProvider>
      <AssistantProvider>
        <div className="flex h-full">
          {/* Mobile overlay backdrop */}
          {isMobile && !collapsed && (
            <div
              className="fixed inset-0 z-40 bg-black/20"
              onClick={toggle}
              aria-hidden="true"
            />
          )}

          <Sidebar collapsed={collapsed} onToggle={toggle} isMobile={isMobile} />
          {/* The assistant panel is absolutely positioned within this
              wrapper, so its expanded mode fills the content area exactly —
              everything except the sidebar — at any sidebar width. The
              overflow must be `clip`, not `hidden`: the closed panel sits
              translated off to the right, and `hidden` still lets focus /
              scrollIntoView inside it scroll the wrapper sideways. */}
          <div className="relative flex min-w-0 flex-1 flex-col overflow-clip">
            <main className="flex flex-1 flex-col overflow-hidden bg-white">
              {isMobile && collapsed && (
                <div className="flex h-14 flex-shrink-0 items-center border-b border-gray-100 px-3">
                  <button
                    onClick={toggle}
                    aria-label="Open navigation"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100"
                  >
                    <Menu size={18} />
                  </button>
                </div>
              )}
              {children}
            </main>

            {/* Global assistant — slide-over chat available over any page (⌘J). */}
            <AssistantPanel />
          </div>
        </div>
      </AssistantProvider>
    </PageContextProvider>
  );
}
