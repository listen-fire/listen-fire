"use client";

// This product app keeps `/` only as a router: logged-in users land on /home;
// logged-out visitors are sent to /login. The public marketing landing lives in
// the standalone apps/marketing app, on its own host, and is reached directly
// rather than via this redirect.
//
// A single-tenant install may not run the unit /home belongs to, so it lands on
// the first nav entry it does run — and the redirect waits for the capabilities
// probe to settle, or it would decide before knowing which install this is.

import { useEffect } from "react";

import { useAuth } from "@/lib/auth";
import { firstMountedHref } from "@/lib/capabilities";
import { useCapabilities, useCapabilitiesSettled } from "@/lib/capabilities-provider";

export default function RootPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const capabilities = useCapabilities();
  const settled = useCapabilitiesSettled();

  useEffect(() => {
    if (isLoading || !settled) return;
    // Both targets are internal — replace so `/` doesn't sit in history.
    if (!isAuthenticated) {
      window.location.replace("/login");
      return;
    }
    window.location.replace(
      capabilities?.identity === "static" ? firstMountedHref(capabilities) : "/home",
    );
  }, [isAuthenticated, isLoading, settled, capabilities]);

  // Nothing to render — `/` is purely a redirect.
  return null;
}
