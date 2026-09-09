"use client";

/**
 * The build-stage plan overlay (plans/2026-06-16-demo-build-stage). While the
 * agent writes the movement underneath, this sits over the editor with a barely
 * -there blur + darken and walks through the agent's ~5-step plan at intervals —
 * conveying "it's doing clever stuff" without making the user read code. It
 * advances on a timer and holds on the last step until the build resolves (the
 * building page unmounts onto the real movement).
 */

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

const STEP_MS = 15000;

export function BuildPlanOverlay({
  steps,
  rightInset = 0,
  dismissing = false,
}: {
  steps: string[];
  /** px to reserve on the right so the text centers in the area the assistant
   *  panel doesn't cover (the panel slides over the right of the editor). */
  rightInset?: number;
  /** When the build resolves, the overlay lifts away like a curtain to reveal
   *  the finished program underneath — rather than hard-cutting to nothing. */
  dismissing?: boolean;
}) {
  const [i, setI] = useState(0);

  useEffect(() => {
    setI(0);
    if (steps.length <= 1) return;
    const t = setInterval(() => {
      setI((prev) => (prev < steps.length - 1 ? prev + 1 : prev));
    }, STEP_MS);
    return () => clearInterval(t);
  }, [steps]);

  if (steps.length === 0) return null;

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center backdrop-blur-[4px] transition-[transform,opacity] duration-[650ms] ease-in-out ${
        dismissing ? "-translate-y-full opacity-0" : "translate-y-0 opacity-100"
      }`}
      style={{ paddingRight: rightInset }}
    >
      <div className="absolute inset-0 bg-gradient-to-b from-slate-900/[0.04] via-slate-900/[0.06] to-slate-900/[0.09]" />
      <div className="relative flex max-w-lg flex-col items-center px-8 text-center">
        <div className="mb-5 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-primary-500">
          <Sparkles size={14} className="animate-pulse" />
          Building your automation
        </div>
        {/* keyed so the step re-mounts and re-runs the fade-in */}
        <div
          key={i}
          className="min-h-[64px] text-[22px] font-medium leading-snug text-gray-800 [animation:fadeStep_500ms_ease]"
        >
          {steps[i]}
        </div>
        <div className="mt-7 flex items-center gap-2">
          {steps.map((_, k) => (
            <span
              key={k}
              className={`h-1.5 rounded-full transition-all duration-500 ${
                k === i
                  ? "w-6 bg-primary-500"
                  : k < i
                    ? "w-1.5 bg-primary-300"
                    : "w-1.5 bg-gray-300"
              }`}
            />
          ))}
        </div>
      </div>
      <style jsx global>{`
        @keyframes fadeStep {
          from {
            opacity: 0;
            transform: translateY(6px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
