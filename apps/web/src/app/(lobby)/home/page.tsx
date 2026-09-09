"use client";

/**
 * `/home` — the lobby (front door).
 *
 * A blank white page with one thing on it: the onboarding, which says "connect
 * Listen-Fire to your Claude and build there". Nothing else competes for attention —
 * no header, no nav, no status. The single piece of persistent chrome is a
 * light × in the corner, the one way out of the flow and into the platform
 * proper (/dashboard, the sidebar app).
 *
 * The Stripe-return notice stays mounted because checkout redirects land here;
 * it floats over whichever card is showing.
 *
 */

import Link from "next/link";
import { X } from "lucide-react";

import { usePageTitle } from "@/components/page-title";
import { OnboardingFlow } from "@/components/onboarding";

export default function LobbyPage() {
  usePageTitle("Home — Listen-Fire");

  return (
    <main className="min-h-dvh bg-white">
      <Link
        href="/dashboard"
        aria-label="Go to the platform"
        className="fixed right-3 top-3 z-40 p-4 text-gray-300 transition-colors hover:text-gray-500"
        data-testid="lobby-enter-platform"
      >
        <X size={20} strokeWidth={1.5} />
      </Link>

      <OnboardingFlow />
    </main>
  );
}
