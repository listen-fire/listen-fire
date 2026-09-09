"use client";

/**
 * The narrated build timeline (plans/2026-06-16-demo-build-stage). In demo mode
 * the agent's authoring streams in as phase beats; this renders them in the
 * assistant panel — completed beats checked and dimmed, the current one
 * highlighted with the real artifact it's working on (a playbook passage, the
 * schema it found, the option it picked), so the user watches the work happen.
 */

import {
  BookOpen,
  Check,
  Lightbulb,
  PencilRuler,
  Search,
  Sparkles,
  TriangleAlert,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { BuildBeat, BuildPhase } from "./build-stage-controller";

const PHASE_ICON: Record<BuildPhase, LucideIcon> = {
  plan: Lightbulb,
  read: BookOpen,
  study: Search,
  draft: PencilRuler,
  fill: Sparkles,
  check: Check,
  fix: Wrench,
  live: Zap,
};

export function BuildTimeline({
  beats,
  plan = [],
  onDismiss,
}: {
  beats: BuildBeat[];
  plan?: string[];
  onDismiss?: () => void;
}) {
  if (beats.length === 0 && plan.length === 0) return null;
  const lastIdx = beats.length - 1;

  return (
    <div className="border-b border-gray-100 bg-gradient-to-b from-primary-50/40 to-transparent px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary-600">
        <Sparkles size={12} />
        Building your automation
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="ml-auto flex h-5 w-5 cursor-pointer items-center justify-center rounded text-primary-400 transition-colors hover:bg-primary-100 hover:text-primary-600"
            title="Dismiss"
            aria-label="Dismiss build panel"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {plan.length > 0 && (
        <ol className="mb-2.5 flex flex-col gap-1 border-b border-primary-100/60 pb-2.5">
          {plan.map((step, i) => (
            <li key={i} className="flex gap-2 text-[12px] leading-snug text-gray-600">
              <span className="mt-px shrink-0 font-semibold text-primary-400">{i + 1}.</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}
      <ol className="flex flex-col gap-1.5">
        {beats.map((beat, i) => {
          const Icon = PHASE_ICON[beat.phase] ?? Sparkles;
          const current = i === lastIdx && beat.phase !== "live";
          const isFix = beat.phase === "fix";
          return (
            <li key={i} className="flex gap-2.5">
              <div
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                  current
                    ? isFix
                      ? "bg-amber-100 text-amber-600"
                      : "bg-primary-100 text-primary-600"
                    : beat.phase === "live"
                      ? "bg-green-100 text-green-600"
                      : "bg-gray-100 text-gray-400"
                }`}
              >
                {current ? (
                  isFix ? <TriangleAlert size={12} /> : <Icon size={12} />
                ) : beat.phase === "live" ? (
                  <Zap size={12} />
                ) : (
                  <Check size={12} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className={`text-[12.5px] leading-5 ${
                    current
                      ? "font-medium text-gray-900"
                      : beat.phase === "live"
                        ? "font-medium text-green-700"
                        : "text-gray-400"
                  }`}
                >
                  {beat.label}
                </div>
                {current && beat.artifact && (
                  <div className="mt-1 rounded-md border-l-2 border-primary-300 bg-white/70 px-2 py-1 text-[11px] leading-snug text-gray-500">
                    {beat.artifact}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
