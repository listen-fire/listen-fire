"use client";

/**
 * The assistant — a right slide-over available over any page, opened
 * from the floating corner button or ⌘J (⌘K is search). It has two
 * widths: the compact panel, and an in-place expansion that fills the
 * content area (everything except the sidebar). Expanded mode carries
 * the affordances the old /ask page used to own — the persistent
 * conversation rail and the working document panel — so there is no
 * separate assistant page any more.
 *
 * Every turn sent from here attaches the current page context
 * (published via `usePublishPageContext`, plus the route) so the agent
 * knows what the user is looking at.
 *
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  FilePlus2,
  History,
  Lock,
  Maximize2,
  Minimize2,
  Navigation,
  Pencil,
  SquarePen,
  X,
} from "lucide-react";
import { AssistantIcon } from "@/components/icons";

import {
  usePublishedPageContext,
  type PageContext,
} from "@/components/page-context";
import { useIsMobile } from "@/lib/use-is-mobile";
import { ResizablePanel } from "@/components/resizable-panel";
import { PanelDrawer } from "@/components/panel-drawer";
import { trpc } from "@/lib/trpc";
import { runConnectAction } from "@/components/movements/connect-actions";
import { useAssistant } from "./provider";
import { MorphingAssistantIcon } from "./morph-icon";
import { useAssistantChat } from "./use-assistant-chat";
import { BuildTimeline } from "./build-timeline";
import { MessageList } from "./messages";
import { Composer, FileDropZone } from "./composer";
import { ConversationHistory } from "./history";
import { AssistantEntityDrawer } from "./entity-drawer";
import { WorkingDocumentPanel } from "./working-document";
import type { SuggestedAction } from "./types";

/** Route-level fallback when the page hasn't published anything richer. */
function pageNameFromPath(pathname: string | null): string {
  if (!pathname || pathname === "/") return "Home";
  const segment = pathname.split("/").filter(Boolean)[0] ?? "";
  return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, " ");
}

function HeaderIconButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}

export function AssistantPanel() {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const published = usePublishedPageContext();
  const {
    panelOpen: open,
    panelExpanded: expanded,
    openPanel,
    closePanel,
    togglePanel,
    setPanelExpanded,
    activeConversationId,
    setActiveConversationId,
    activeLegacyDomain,
    pendingMessage,
    clearPendingMessage,
    followActive,
    followPaused,
    canFollow,
    toggleFollow,
    navigateOnSavedMovement,
    followIntent,
    buildBeats,
    buildPlan,
    buildDraft,
    pushBuildBeat,
    setBuildDraft,
    setBuildPlan,
    resetBuild,
  } = useAssistant();

  // The in-app assistant is for established users. A brand-new (empty) team
  // builds in Claude via MCP and never sees the launcher — the `empty`
  // discriminator is the same signal the dashboard uses, and its query path is
  // cheap (early-returns server-side; react-query dedupes with the dashboard's
  // own call).
  const { data: dashboardState } = trpc.views.home.getDashboard.useQuery();
  const teamEmpty = dashboardState?.kind === "empty";

  const [view, setView] = useState<"chat" | "history">("chat");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showWorkingDoc, setShowWorkingDoc] = useState(true);
  const [launcherHot, setLauncherHot] = useState(false);
  // The build timeline can be dismissed; a fresh build (new plan/draft) re-shows it.
  const [buildDismissed, setBuildDismissed] = useState(false);
  const buildActiveSignal = buildPlan.length > 0 || buildDraft !== null;
  const wasBuildActiveRef = useRef(false);
  useEffect(() => {
    if (buildActiveSignal && !wasBuildActiveRef.current) setBuildDismissed(false);
    wasBuildActiveRef.current = buildActiveSignal;
  }, [buildActiveSignal]);

  // The structured context block attached to each turn.
  const pageContext = useMemo<PageContext & { path: string }>(
    () => ({
      page: published?.page ?? pageNameFromPath(pathname),
      path: pathname ?? "/",
      ...(published?.entities?.length ? { entities: published.entities } : {}),
      ...(published?.extras && Object.keys(published.extras).length > 0
        ? { extras: published.extras }
        : {}),
    }),
    [published, pathname],
  );

  const chat = useAssistantChat({
    pageContext,
    sessionPrefix: "ap",
    onConversationChange: setActiveConversationId,
    onMovementSaved: navigateOnSavedMovement,
    getShowMode: followIntent,
    onBuildBeat: (beat) => pushBuildBeat(beat as Parameters<typeof pushBuildBeat>[0]),
    onDraft: setBuildDraft,
    onPlan: setBuildPlan,
    onBuildReset: resetBuild,
  });
  const { conversationId, legacyDomain, openConversation, workingDocUri } =
    chat;

  const utils = trpc.useUtils();
  // A suggested action either sends its message back to the agent (the
  // default) OR — when it carries a `connectAction` — dispatches to the app's
  // connect-action handler registry by `kind`, the SAME registry the movement
  // editor uses (the generalised "+" connect affordance, chat surface). After
  // a grant, refresh the movement catalog so the agent's next describeInstance
  // sees it.
  const handleSuggestedAction = useCallback(
    (action: SuggestedAction) => {
      if (action.connectAction) {
        const ca = action.connectAction;
        void runConnectAction(ca.kind, {
          adapter: ca.adapter,
          ...(ca.credential !== undefined ? { credential: ca.credential } : {}),
          ...(ca.serviceType !== undefined ? { serviceType: ca.serviceType } : {}),
          client: utils.client,
          refreshInstance: () => {
            void utils.views.movement.catalog.invalidate();
          },
        })
          .then((ran) => {
            if (ran && ca.kind === "connect-credential") {
              void chat.send(`I've connected ${ca.adapter}.`);
            }
          })
          .catch((err) => {
            console.error("Connect action failed:", err);
          });
        return;
      }
      void chat.send(action.message);
    },
    [utils, chat],
  );

  // Adopt the shared active conversation. Not gated on the open
  // TRANSITION: when another surface opens the panel and navigates
  // (e.g. /setup → Home), the panel mounts already-open, so there is no
  // transition to catch — we adopt whenever the panel is open and the
  // shared id differs from what's loaded. `adoptedRef` stops us
  // re-opening the same id every render; it resets when the panel closes.
  const adoptedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      adoptedRef.current = null;
      return;
    }
    if (
      activeConversationId &&
      activeConversationId !== conversationId &&
      activeConversationId !== adoptedRef.current
    ) {
      adoptedRef.current = activeConversationId;
      setView("chat");
      void openConversation(activeConversationId, {
        legacyDomain: activeLegacyDomain,
      });
    }
  }, [open, activeConversationId, conversationId, openConversation, activeLegacyDomain]);

  // A message handed over from elsewhere (global search's "Ask AI")
  // starts a fresh conversation: clear any active one first, then send
  // on the following render once the chat state has reset.
  useEffect(() => {
    if (!open || pendingMessage === null) return;
    setView("chat");
    if (chat.conversationId) {
      chat.newChat();
      return;
    }
    clearPendingMessage();
    void chat.send(pendingMessage);
  }, [open, pendingMessage, chat, clearPendingMessage]);

  // Show the working doc panel whenever a document appears.
  useEffect(() => {
    if (workingDocUri) setShowWorkingDoc(true);
  }, [workingDocUri]);

  // ⌘J toggles the panel; Escape steps back
  // (entity drawer → history → expanded → closed).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        if (teamEmpty) return;
        e.preventDefault();
        togglePanel();
      } else if (e.key === "Escape" && open) {
        if (selectedNodeId) {
          setSelectedNodeId(null);
        } else if (view === "history") {
          setView("chat");
        } else if (expanded) {
          setPanelExpanded(false);
        } else {
          closePanel();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    open,
    view,
    selectedNodeId,
    expanded,
    teamEmpty,
    togglePanel,
    closePanel,
    setPanelExpanded,
  ]);

  const handleNewChat = useCallback(() => {
    chat.newChat();
    setView("chat");
  }, [chat]);

  const contextSummary = useMemo(() => {
    const firstEntity = pageContext.entities?.[0];
    return firstEntity?.name
      ? `${pageContext.page} — ${firstEntity.name}`
      : pageContext.page;
  }, [pageContext]);

  // The persistent conversation rail replaces the swap-view in
  // expanded desktop mode.
  const showHistoryRail = expanded && !isMobile;
  const chatView = view === "chat" || showHistoryRail;

  // While closed, the panel must be fully out of the page for keyboards
  // and screen readers — aria-hidden alone leaves its controls tabbable
  // (and focusing them would drag the clipped wrapper sideways). The
  // attribute must be applied at render (not in an effect): child
  // effects run before parent effects, so the Composer's focus-on-open
  // would land while the panel was still inert. React 18.3 renders a
  // boolean `inert` but its TS types don't declare it (React 19's do) —
  // hence the spread-with-cast.
  const inertProps = (open ? {} : { inert: true }) as Record<string, unknown>;

  return (
    <>
      {/* Corner affordance — the product mark, morphing into a speech
          bubble on hover/focus (the mark becomes a conversation). Hidden for
          an empty team: newcomers build in Claude and never see the in-app chat
          until they're established. */}
      {!open && !teamEmpty && (
        <button
          onClick={() => openPanel()}
          onMouseEnter={() => setLauncherHot(true)}
          onMouseLeave={() => setLauncherHot(false)}
          onFocus={() => setLauncherHot(true)}
          onBlur={() => setLauncherHot(false)}
          title="Assistant (⌘J)"
          aria-label="Open assistant"
          className="absolute bottom-5 right-5 z-40 flex h-12 w-12 cursor-pointer items-center justify-center rounded-full bg-primary text-white shadow-lg shadow-primary/25 transition-all hover:scale-105 hover:bg-primary-600"
        >
          <MorphingAssistantIcon active={launcherHot} className="h-5 w-5" />
          <kbd
            className={`pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-gray-900 px-1.5 py-0.5 text-[10px] tracking-wide text-white shadow transition-opacity ${
              launcherHot ? "opacity-100" : "opacity-0"
            }`}
          >
            ⌘J
          </kbd>
        </button>
      )}

      {/* Slide-over panel */}
      <div
        {...inertProps}
        role="complementary"
        aria-label="Assistant"
        className={`absolute inset-y-0 right-0 z-50 flex flex-col border-l border-gray-200 bg-white shadow-2xl transition-[transform,width] duration-200 ${
          expanded ? "w-full" : "w-full sm:w-[440px]"
        } ${open ? "translate-x-0" : "translate-x-full"}`}
        aria-hidden={!open}
      >
        {/* Header */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-100 px-4">
          <div className="flex items-center gap-2.5">
            {!chatView ? (
              <button
                onClick={() => setView("chat")}
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                title="Back to chat"
              >
                <ArrowLeft size={15} />
              </button>
            ) : (
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary-50 text-primary-500">
                <AssistantIcon className="h-3.5 w-3.5" />
              </div>
            )}
            <span className="text-[14px] font-semibold text-gray-900">
              {!chatView ? "Conversations" : "Assistant"}
            </span>
            {chatView && legacyDomain && (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                {legacyDomain}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {chatView && (
              <>
                {canFollow && (
                  <button
                    onClick={toggleFollow}
                    className={`mr-0.5 flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium transition-colors ${
                      followActive
                        ? "bg-primary/10 text-primary hover:bg-primary/15"
                        : followPaused
                          ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
                          : "text-gray-500 hover:bg-gray-100"
                    }`}
                    title={
                      followActive
                        ? "Following the agent — click to stop"
                        : followPaused
                          ? "Paused because you navigated — click to resume"
                          : "Follow along — jump to what the agent builds as it works"
                    }
                    aria-pressed={followActive}
                  >
                    <Navigation
                      size={13}
                      className={followActive ? "fill-current" : undefined}
                    />
                    <span className="hidden sm:inline">
                      {followActive
                        ? "Following"
                        : followPaused
                          ? "Paused"
                          : "Follow"}
                    </span>
                  </button>
                )}
                {expanded && conversationId && !workingDocUri && (
                  <HeaderIconButton
                    onClick={() => void chat.createWorkingDocument()}
                    title="New working document"
                  >
                    <FilePlus2 size={15} />
                  </HeaderIconButton>
                )}
                {expanded && conversationId && workingDocUri && (
                  <>
                    <button
                      onClick={() => setShowWorkingDoc((v) => !v)}
                      className={`flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium transition-colors ${
                        showWorkingDoc
                          ? "bg-primary/5 text-primary hover:bg-primary/10"
                          : "text-gray-500 hover:bg-gray-100"
                      }`}
                      title={
                        showWorkingDoc
                          ? "Hide working document"
                          : "Show working document"
                      }
                    >
                      <FilePlus2 size={13} />
                      <span className="hidden max-w-40 truncate lg:inline">
                        {chat.workingDocTitle ?? "Document"}
                      </span>
                    </button>
                    <div className="mr-1 flex items-center rounded-lg border border-gray-200 text-[12px] font-medium">
                      <button
                        onClick={() => chat.setDocumentMode("collaborating")}
                        className={`cursor-pointer rounded-l-lg px-2 py-1 transition-colors ${
                          chat.documentMode === "collaborating"
                            ? "bg-primary/10 text-primary"
                            : "text-gray-500 hover:bg-gray-50"
                        }`}
                        title="Agent can read and write the document"
                        aria-label="Agent can read and write the document"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => chat.setDocumentMode("input")}
                        className={`cursor-pointer rounded-r-lg px-2 py-1 transition-colors ${
                          chat.documentMode === "input"
                            ? "bg-amber-100 text-amber-700"
                            : "text-gray-500 hover:bg-gray-50"
                        }`}
                        title="Agent can only read the document (input mode)"
                        aria-label="Agent can only read the document (input mode)"
                      >
                        <Lock size={13} />
                      </button>
                    </div>
                  </>
                )}
                {!showHistoryRail && (
                  <HeaderIconButton
                    onClick={() => setView("history")}
                    title="Conversation history"
                  >
                    <History size={15} />
                  </HeaderIconButton>
                )}
                <HeaderIconButton
                  onClick={handleNewChat}
                  title="New conversation"
                >
                  <SquarePen size={15} />
                </HeaderIconButton>
                <HeaderIconButton
                  onClick={() => setPanelExpanded(!expanded)}
                  title={expanded ? "Collapse to side panel" : "Expand"}
                >
                  {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </HeaderIconButton>
              </>
            )}
            <HeaderIconButton onClick={closePanel} title="Close (Esc)">
              <X size={16} />
            </HeaderIconButton>
          </div>
        </div>

        {!chatView ? (
          <ConversationHistory
            enabled={open}
            activeConversationId={conversationId}
            onSelect={(conv) => {
              setView("chat");
              void openConversation(conv.id, {
                legacyDomain: conv.legacyDomain,
              });
            }}
          />
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* Conversation rail (expanded desktop only) */}
            {showHistoryRail && (
              <div className="flex w-64 shrink-0 flex-col border-r border-gray-100 bg-gray-50/50">
                <ConversationHistory
                  enabled={open}
                  activeConversationId={conversationId}
                  onSelect={(conv) =>
                    void openConversation(conv.id, {
                      legacyDomain: conv.legacyDomain,
                    })
                  }
                />
              </div>
            )}

            {/* Chat column */}
            <FileDropZone
              onFiles={(files) => void chat.uploadFiles(files)}
              className="flex min-h-0 min-w-0 flex-1 flex-col"
            >
              {buildActiveSignal && !buildDismissed && (
                <BuildTimeline
                  beats={buildBeats}
                  plan={buildPlan}
                  onDismiss={() => setBuildDismissed(true)}
                />
              )}
              <div
                className={`flex-1 overflow-y-auto px-4 py-4 ${expanded ? "sm:px-6 sm:py-6" : ""}`}
              >
                <div className={expanded ? "mx-auto max-w-2xl" : undefined}>
                  <MessageList
                    messages={chat.messages}
                    isLoading={chat.isLoading}
                    agentStatus={chat.agentStatus}
                    onSuggestedAction={handleSuggestedAction}
                    onEntityClick={setSelectedNodeId}
                    emptyCaption="Your data, your automations, this page — the assistant can see what you're looking at."
                  />
                </div>
              </div>
              <div
                className={expanded ? "mx-auto w-full max-w-2xl" : undefined}
              >
                <Composer
                  chat={chat}
                  placeholder="Ask about this page or anything else…"
                  contextLabel={contextSummary}
                  autoFocus={open && chatView}
                />
              </div>
            </FileDropZone>

            {/* Working document panel (expanded only) */}
            {expanded &&
              workingDocUri &&
              conversationId &&
              (isMobile ? (
                <PanelDrawer
                  side="right"
                  open={showWorkingDoc}
                  onClose={() => setShowWorkingDoc(false)}
                >
                  <WorkingDocumentPanel
                    conversationId={conversationId}
                    title={chat.workingDocTitle}
                    refreshKey={chat.docRefreshKey}
                    onDiscard={chat.onWorkingDocumentDiscarded}
                  />
                </PanelDrawer>
              ) : (
                showWorkingDoc && (
                  <ResizablePanel
                    side="right"
                    defaultWidth={560}
                    minWidth={320}
                    maxWidth={800}
                    storageKey="panel:assistant:workingDoc"
                  >
                    <WorkingDocumentPanel
                      conversationId={conversationId}
                      title={chat.workingDocTitle}
                      refreshKey={chat.docRefreshKey}
                      onDiscard={chat.onWorkingDocumentDiscarded}
                    />
                  </ResizablePanel>
                )
              ))}
          </div>
        )}
      </div>

      <AssistantEntityDrawer
        nodeId={selectedNodeId}
        onClose={() => setSelectedNodeId(null)}
        onNavigate={setSelectedNodeId}
      />
    </>
  );
}
