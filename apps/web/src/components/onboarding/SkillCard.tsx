"use client";

/**
 * Card 2 — the Builder skill. The connector gives Claude the tools; the skill
 * teaches it how to use them. Same shape as card 1: headline, action, one
 * quiet line saying where the downloaded file goes.
 */

import { buttonClass } from "@/components/ui";

const SKILL_FILE = "/listen-fire-builder.skill";
const SKILLS_SETTINGS_URL = "https://claude.ai/new#settings/customize-skills";

export function SkillCard({ onAction }: { onAction: () => void }) {
  return (
    <div className="flex flex-col items-center gap-8" data-testid="skill-card">
      <h1 className="text-[26px] font-semibold tracking-tight text-gray-900">
        Teach Claude the skill
      </h1>

      <a
        href={SKILL_FILE}
        download="listen-fire-builder.skill"
        onClick={onAction}
        className={buttonClass({ variant: "primary" })}
        data-testid="download-skill"
      >
        Download the skill
      </a>

      <p className="text-[12px] text-gray-400">
        Then upload it in{" "}
        <a
          href={SKILLS_SETTINGS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-gray-200 underline-offset-2 hover:text-gray-600"
        >
          Claude&apos;s skill settings
        </a>
        .
      </p>
    </div>
  );
}
