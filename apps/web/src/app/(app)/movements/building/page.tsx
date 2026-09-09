"use client";

/**
 * The demo build stage (plans/2026-06-16-demo-build-stage). When the user is
 * watching (Follow armed), the agent navigates here the instant it starts an
 * automation. The editor types the program in as the agent submits drafts
 * (the build state lives on the assistant provider, fed by its stream); the
 * narration runs in the assistant panel. When the agent's final save goes
 * live, the build controller replaces this route with the real movement page.
 */

import { useEffect, useRef } from "react";
import { Loader2, Sparkles } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { useAssistant } from "@/components/assistant/provider";
import {
  MovementEditor,
  type MovementEditorHandle,
} from "@/components/movements/movement-editor";
import { BuildPlanOverlay } from "@/components/movements/build-plan-overlay";

// The assistant panel slides over the right of the content at this width when
// compact; reserve it so the overlay text centers in the visible area.
const PANEL_W = 440;

export default function MovementBuildingPage() {
  const { buildDraft, buildPlan, buildDismissing, panelOpen, panelExpanded } =
    useAssistant();
  const overlayRightInset = panelOpen && !panelExpanded ? PANEL_W : 0;
  const editorRef = useRef<MovementEditorHandle>(null);

  const { data: catalog } = trpc.views.movement.catalog.useQuery(undefined, {
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // Type each new draft in via the editor's diff animation.
  useEffect(() => {
    if (buildDraft != null) editorRef.current?.animateToSource(buildDraft);
  }, [buildDraft]);

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-100 px-4">
        <Sparkles size={15} className="text-primary-500" />
        <span className="text-[14px] font-semibold text-gray-900">
          Building your automation
        </span>
        <Loader2 size={13} className="animate-spin text-gray-300" />
      </div>
      <div className="relative min-h-0 flex-1">
        {catalog ? (
          <MovementEditor
            ref={editorRef}
            initialValue=""
            snapshot={catalog.snapshot}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] text-gray-400">
            Preparing the canvas…
          </div>
        )}
        {buildPlan.length > 0 && (
          <BuildPlanOverlay
            steps={buildPlan}
            rightInset={overlayRightInset}
            dismissing={buildDismissing}
          />
        )}
      </div>
    </div>
  );
}
