"use client";

/**
 * Build stage — the live state behind the demo-mode "watch it come together"
 * (plans/2026-06-16-demo-build-stage). The assistant's chat subscription feeds
 * it two streams from the agent: `build` beats (phases + artifacts, shown in
 * the panel) and `draft` source (typed into the editor on the building page).
 *
 * It also drives navigation: on the first beat of a build (while Follow is
 * armed) it enters the building stage; on the final `live` beat it resolves to
 * the saved movement's real page.
 */

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type BuildPhase =
  | "plan"
  | "read"
  | "study"
  | "draft"
  | "fill"
  | "check"
  | "fix"
  | "live";

export interface BuildBeat {
  phase: BuildPhase;
  label: string;
  artifact?: string;
  movementId?: string;
}

/** How long the plan overlay takes to lift away before we swap to the real
 *  movement — kept just above the overlay's own 650ms transition so the curtain
 *  has fully cleared the viewport before navigation. */
const OVERLAY_EXIT_MS = 700;

export interface BuildStageController {
  /** Ordered phase beats for the current build (panel timeline). */
  buildBeats: BuildBeat[];
  /** Latest program source the agent submitted (editor types it in). */
  buildDraft: string | null;
  /** A narrated build is in flight. */
  buildActive: boolean;
  /** The agent's ~5-step plan, shown on the editor overlay + sidebar. */
  buildPlan: string[];
  /** The build resolved — the overlay is lifting away to reveal the result. */
  buildDismissing: boolean;
  /** Append a beat (enters the stage on the first one; resolves on `live`). */
  pushBuildBeat: (beat: BuildBeat) => void;
  /** Record the latest draft source. */
  setBuildDraft: (source: string) => void;
  /** Record the plan steps (enters the stage too). */
  setBuildPlan: (steps: string[]) => void;
  /** Start fresh — called when a new turn is sent in show mode. */
  resetBuild: () => void;
}

export function useBuildStageController(
  activeConversationId: string | null,
): BuildStageController {
  const router = useRouter();

  const [buildBeats, setBuildBeats] = useState<BuildBeat[]>([]);
  const [buildDraft, setBuildDraftState] = useState<string | null>(null);
  const [buildActive, setBuildActive] = useState(false);
  const [buildPlan, setBuildPlanState] = useState<string[]>([]);
  const [buildDismissing, setBuildDismissing] = useState(false);
  const enteredRef = useRef(false);
  const hasPlanRef = useRef(false);

  // Beats/drafts only arrive when the backend already ran in show mode, so
  // their presence IS the intent to watch — don't re-gate on followActive
  // (which can lag behind on the first turn of a fresh conversation).
  const enterStageOnce = useCallback(() => {
    if (enteredRef.current) return;
    if (!activeConversationId) return;
    enteredRef.current = true;
    setBuildActive(true);
    router.push(`/movements/building?c=${encodeURIComponent(activeConversationId)}`);
  }, [activeConversationId, router]);

  const resetBuild = useCallback(() => {
    enteredRef.current = false;
    hasPlanRef.current = false;
    setBuildBeats([]);
    setBuildDraftState(null);
    setBuildActive(false);
    setBuildPlanState([]);
    setBuildDismissing(false);
  }, []);

  const pushBuildBeat = useCallback(
    (beat: BuildBeat) => {
      setBuildBeats((prev) => {
        // Collapse a repeating step (e.g. "Writing it out…" once per chunk) into
        // a single row — update it in place rather than piling up duplicates.
        const last = prev[prev.length - 1];
        if (last && last.phase === beat.phase && last.label === beat.label) {
          return [...prev.slice(0, -1), beat];
        }
        return [...prev, beat];
      });
      if (beat.phase === "live" && beat.movementId) {
        const movementId = beat.movementId;
        const goToResult = () => {
          setBuildActive(false);
          router.replace(`/movements/${movementId}`);
        };
        if (hasPlanRef.current) {
          // Let the overlay lift away to reveal the finished program before the
          // route swaps — so it doesn't just blink out.
          setBuildDismissing(true);
          window.setTimeout(goToResult, OVERLAY_EXIT_MS);
        } else {
          goToResult();
        }
      }
      // NOTE: beats alone (reading docs, studying tools) DON'T enter the stage —
      // those happen for many tasks. Only a plan or a draft (a real movement
      // being written) does, so the demo never fires for non-movement requests.
    },
    [router],
  );

  const setBuildDraft = useCallback(
    (source: string) => {
      setBuildDraftState(source);
      enterStageOnce();
    },
    [enterStageOnce],
  );

  const setBuildPlan = useCallback(
    (steps: string[]) => {
      setBuildPlanState(steps);
      hasPlanRef.current = steps.length > 0; // an overlay is up → animate its exit
      enterStageOnce(); // the plan is the first thing — get to the stage now
    },
    [enterStageOnce],
  );

  return {
    buildBeats,
    buildDraft,
    buildActive,
    buildPlan,
    buildDismissing,
    pushBuildBeat,
    setBuildDraft,
    setBuildPlan,
    resetBuild,
  };
}
