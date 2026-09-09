"use client";

/**
 * Shared assistant state — one assistant, two panel widths.
 *
 * The slide-over panel is the only presentation: it either sits at its
 * compact width or expands in place to fill the content area (the old
 * /ask page is gone). This provider carries what must survive route
 * changes and width toggles: whether the panel is open, whether it is
 * expanded, which conversation is active, and a pending message handed
 * over from elsewhere in the app (e.g. global search's "Ask AI").
 *
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { useFollowController } from "./follow-controller";
import {
  useBuildStageController,
  type BuildBeat,
} from "./build-stage-controller";

type OpenPanelOpts = {
  legacyDomain?: string | null;
  /** Arm follow-along for this conversation (the setup/onboarding hand-off). */
  followByDefault?: boolean;
};

type AssistantContextValue = {
  panelOpen: boolean;
  panelExpanded: boolean;
  openPanel: (conversationId?: string | null, opts?: OpenPanelOpts) => void;
  closePanel: () => void;
  togglePanel: () => void;
  setPanelExpanded: (expanded: boolean) => void;
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
  /** Domain to open the active conversation under (e.g. "setup"). */
  activeLegacyDomain: string | null;
  /** Open the panel and have it send this message (global search hand-off). */
  sendToAssistant: (message: string, opts?: { followByDefault?: boolean }) => void;
  pendingMessage: string | null;
  clearPendingMessage: () => void;
  // ── Follow-along (plans/2026-06-16-follow-along) ──
  /** Following is engaged (armed and not paused). */
  followActive: boolean;
  /** Armed but paused because the user navigated manually. */
  followPaused: boolean;
  /** Following can be engaged (there is an active conversation). */
  canFollow: boolean;
  /** Toggle following for the active conversation (also resumes from pause). */
  toggleFollow: () => void;
  /** Navigate to a just-saved movement when following (chat subscription calls this). */
  navigateOnSavedMovement: (movementId: string) => void;
  /** Will this turn be followed? (active, or a follow-default still pending). */
  followIntent: () => boolean;
  // ── Demo build stage (plans/2026-06-16-demo-build-stage) ──
  buildBeats: BuildBeat[];
  buildDraft: string | null;
  buildActive: boolean;
  buildPlan: string[];
  buildDismissing: boolean;
  pushBuildBeat: (beat: BuildBeat) => void;
  setBuildDraft: (source: string) => void;
  setBuildPlan: (steps: string[]) => void;
  resetBuild: () => void;
};

const AssistantContext = createContext<AssistantContextValue | null>(null);

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [activeLegacyDomain, setActiveLegacyDomain] = useState<string | null>(
    null,
  );

  const follow = useFollowController(activeConversationId);
  const { seedFollowDefault } = follow;
  const build = useBuildStageController(activeConversationId);

  const openPanel = useCallback(
    (conversationId?: string | null, opts?: OpenPanelOpts) => {
      if (conversationId !== undefined) setActiveConversationId(conversationId);
      if (opts && "legacyDomain" in opts)
        setActiveLegacyDomain(opts.legacyDomain ?? null);
      if (opts?.followByDefault) seedFollowDefault(conversationId ?? null);
      setPanelOpen(true);
    },
    [seedFollowDefault],
  );
  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setPanelExpanded(false);
  }, []);
  const togglePanel = useCallback(() => {
    setPanelOpen((open) => {
      if (open) setPanelExpanded(false);
      return !open;
    });
  }, []);

  const sendToAssistant = useCallback(
    (message: string, opts?: { followByDefault?: boolean }) => {
      setPendingMessage(message);
      if (opts?.followByDefault) seedFollowDefault(null);
      setPanelOpen(true);
    },
    [seedFollowDefault],
  );
  const clearPendingMessage = useCallback(() => setPendingMessage(null), []);

  const value = useMemo(
    () => ({
      panelOpen,
      panelExpanded,
      openPanel,
      closePanel,
      togglePanel,
      setPanelExpanded,
      activeConversationId,
      setActiveConversationId,
      activeLegacyDomain,
      sendToAssistant,
      pendingMessage,
      clearPendingMessage,
      followActive: follow.followActive,
      followPaused: follow.followPaused,
      canFollow: follow.canFollow,
      toggleFollow: follow.toggleFollow,
      navigateOnSavedMovement: follow.navigateOnSavedMovement,
      followIntent: follow.followIntent,
      buildBeats: build.buildBeats,
      buildDraft: build.buildDraft,
      buildActive: build.buildActive,
      buildPlan: build.buildPlan,
      buildDismissing: build.buildDismissing,
      pushBuildBeat: build.pushBuildBeat,
      setBuildDraft: build.setBuildDraft,
      setBuildPlan: build.setBuildPlan,
      resetBuild: build.resetBuild,
    }),
    [
      panelOpen,
      panelExpanded,
      openPanel,
      closePanel,
      togglePanel,
      activeConversationId,
      activeLegacyDomain,
      sendToAssistant,
      pendingMessage,
      clearPendingMessage,
      follow,
      build,
    ],
  );

  return (
    <AssistantContext.Provider value={value}>
      {children}
    </AssistantContext.Provider>
  );
}

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used within AssistantProvider");
  return ctx;
}
