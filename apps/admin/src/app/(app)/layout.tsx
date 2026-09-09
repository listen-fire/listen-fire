"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Menu } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useIsMobile } from "@/lib/use-is-mobile";
import { Sidebar } from "@/components/sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(false);

  // Redirect unauthenticated visitors to the login page, preserving where they
  // were headed so we can return them there after sign-in.
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      const returnUrl = encodeURIComponent(pathname || "/feed");
      router.replace(`/login?returnUrl=${returnUrl}`);
    }
  }, [isLoading, isAuthenticated, pathname, router]);

  // Default collapsed on mobile
  useEffect(() => {
    setCollapsed(isMobile);
  }, [isMobile]);

  // Close sidebar on navigation (mobile)
  useEffect(() => {
    if (isMobile) setCollapsed(true);
  }, [pathname, isMobile]);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  if (isLoading || !isAuthenticated) {
    return null;
  }

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex-1 overflow-hidden">
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
          </div>
        </div>
      </div>
    </div>
  );
}
