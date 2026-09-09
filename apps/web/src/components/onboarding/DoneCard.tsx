"use client";

/**
 * Card 4 — the end of onboarding points AWAY from Listen-Fire: everything is done by
 * asking Claude, so the one action opens Claude. This is also where a returning,
 * onboarded user lands.
 */

import { buttonClass } from "@/components/ui";

export function DoneCard() {
  return (
    <div className="flex flex-col items-center gap-8" data-testid="done-card">
      <h1 className="text-[26px] font-semibold tracking-tight text-gray-900">
        Continue in Claude
      </h1>

      <a
        href="https://claude.ai/new"
        target="_blank"
        rel="noreferrer"
        className={buttonClass({ variant: "primary" })}
        data-testid="open-claude"
      >
        Open Claude
      </a>
    </div>
  );
}
