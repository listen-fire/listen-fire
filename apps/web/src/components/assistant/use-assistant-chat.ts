"use client";

/**
 * The assistant's chat engine — ALL conversation behaviour lives here,
 * shared verbatim by both presentations (slide-over panel and the full
 * /ask page): sending turns to the unified agent, live updates over the
 * subscription with a polling safety net, conversation switching, file
 * attachments, interrupt-and-queue, and the working document state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import type { PageContext } from "@/components/page-context";
import type {
  AttachmentRef,
  DocumentMode,
  Message,
  PendingFile,
  SuggestedAction,
  ToolTraceEntry,
  UploadedFileRef,
} from "./types";

export interface UseAssistantChatOptions {
  /** Attached to each turn (panel presentation publishes the page). */
  pageContext?: (PageContext & { path: string }) | undefined;
  /** Notified whenever the active conversation changes (incl. null on new chat). */
  onConversationChange?: (id: string | null) => void;
  /** Notified when the agent saves a movement (the live stream carries its id). */
  onMovementSaved?: (movementId: string) => void;
  /** Returns whether the user is watching (Follow armed) — turns on demo build mode. */
  getShowMode?: () => boolean;
  /** Demo build stage: a phase beat arrived on the stream. */
  onBuildBeat?: (beat: unknown) => void;
  /** Demo build stage: the agent submitted a new program draft. */
  onDraft?: (source: string) => void;
  /** Demo build stage: the agent's ~5-step plan arrived. */
  onPlan?: (steps: string[]) => void;
  /** Demo build stage: a new turn is starting — clear the prior build. */
  onBuildReset?: () => void;
  /** Session id prefix, for log readability. */
  sessionPrefix?: string;
}

export function useAssistantChat(options: UseAssistantChatOptions = {}) {
  const {
    pageContext,
    onConversationChange,
    onMovementSaved,
    getShowMode,
    onBuildBeat,
    onDraft,
    onPlan,
    onBuildReset,
    sessionPrefix = "as",
  } = options;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationIdRaw] = useState<string | null>(null);
  const [legacyDomain, setLegacyDomain] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [activeAgent, setActiveAgent] = useState<string>("unified");
  const [documentMode, setDocumentModeRaw] = useState<DocumentMode>("collaborating");
  const [workingDocUri, setWorkingDocUri] = useState<string | null>(null);
  const [workingDocTitle, setWorkingDocTitle] = useState<string | null>(null);
  const [docRefreshKey, setDocRefreshKey] = useState(0);

  const completeHandledRef = useRef(false);
  const queuedMessageRef = useRef<string | null>(null);
  const lastStartedSessionRef = useRef<string | null>(null);
  const utils = trpc.useUtils();

  const onConversationChangeRef = useRef(onConversationChange);
  onConversationChangeRef.current = onConversationChange;
  const onMovementSavedRef = useRef(onMovementSaved);
  onMovementSavedRef.current = onMovementSaved;
  const getShowModeRef = useRef(getShowMode);
  getShowModeRef.current = getShowMode;
  const onBuildBeatRef = useRef(onBuildBeat);
  onBuildBeatRef.current = onBuildBeat;
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const onPlanRef = useRef(onPlan);
  onPlanRef.current = onPlan;
  const onBuildResetRef = useRef(onBuildReset);
  onBuildResetRef.current = onBuildReset;
  const setConversationId = useCallback((id: string | null) => {
    setConversationIdRaw(id);
    onConversationChangeRef.current?.(id);
  }, []);

  const { mutateAsync: sendMessage } =
    trpc.views.knowledge.queryAgent.sendMessage.useMutation({ onError: () => {} });
  const { mutateAsync: cancelAgentMut } =
    trpc.views.knowledge.queryAgent.cancelAgent.useMutation();
  const { mutateAsync: createDoc } =
    trpc.views.knowledge.queryAgent.updateWorkingDocument.useMutation();
  const { mutate: setDocumentModeMut } =
    trpc.views.knowledge.queryAgent.setDocumentMode.useMutation();

  const setDocumentMode = useCallback(
    (mode: DocumentMode) => {
      setDocumentModeRaw(mode);
      if (conversationId) setDocumentModeMut({ conversationId, mode });
    },
    [conversationId, setDocumentModeMut],
  );

  // ── Conversation history parsing ──────────────────────────────────

  const parseAgentMessages = useCallback(
    (conv: { agentMessages: Array<Record<string, unknown>> }): Message[] =>
      conv.agentMessages
        .filter(
          (m) =>
            (m.messageType === "chat" || m.messageType == null) &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string" &&
            m.content.length > 0,
        )
        .map((m) => {
          const meta = m.metadata as Record<string, unknown> | null;
          return {
            id: String(m.id),
            role: m.role as "user" | "assistant",
            content: String(m.content),
            trace: (meta?.trace as ToolTraceEntry[]) ?? undefined,
            suggestedActions:
              (meta?.suggestedActions as SuggestedAction[]) ?? undefined,
            attachments: (meta?.attachments as AttachmentRef[]) ?? undefined,
            files: (meta?.uploadedFiles as UploadedFileRef[]) ?? undefined,
            agent: (m.agent as string | null) ?? undefined,
            messageType: (m.messageType as string) ?? undefined,
          };
        }),
    [],
  );

  // ── Live agent updates ─────────────────────────────────────────────

  trpc.views.knowledge.queryAgent.onUpdate.useSubscription(
    { sessionId: sessionId ?? "" },
    {
      enabled: !!sessionId,
      onData: (update) => {
        if (!update || typeof update !== "object") return;

        // Working document updates from agent tool calls
        if (update.type === "tool_call" && update.data?.workingDocumentUri) {
          setWorkingDocUri(update.data.workingDocumentUri);
          if (update.data.workingDocumentTitle) {
            setWorkingDocTitle(update.data.workingDocumentTitle);
          }
          setDocRefreshKey((k) => k + 1);
        }

        // Track active agent on handoff / hand-back
        if (update.type === "tool_call" && (update.data?.handoff || update.data?.handBack)) {
          const handoff = update.data.handoff ?? update.data.handBack;
          setActiveAgent(handoff.to);
        }

        // The agent saved a movement — follow-along navigates to it.
        if (update.type === "tool_call" && typeof update.data?.savedMovementId === "string") {
          onMovementSavedRef.current?.(update.data.savedMovementId);
        }

        // Demo build stage: phase beats + draft source.
        if (update.type === "build" && update.data) {
          onBuildBeatRef.current?.(update.data);
        }
        if (update.type === "draft" && typeof update.data?.source === "string") {
          onDraftRef.current?.(update.data.source);
        }
        if (update.type === "plan" && Array.isArray(update.data?.steps)) {
          onPlanRef.current?.(update.data.steps as string[]);
        }

        if (update.type === "complete") {
          if (completeHandledRef.current) return;
          completeHandledRef.current = true;
          const { text, trace, suggestedActions, attachments, agent: responseAgent } =
            update.data ?? {};
          const resolvedText = text || "No response generated";
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant" && last.content === resolvedText) return prev;
            return [
              ...prev,
              {
                id: `a-${Date.now()}`,
                role: "assistant" as const,
                content: resolvedText,
                trace: (trace as ToolTraceEntry[]) ?? undefined,
                suggestedActions:
                  (suggestedActions as SuggestedAction[]) ?? undefined,
                attachments: (attachments as AttachmentRef[]) ?? undefined,
                agent: responseAgent ?? activeAgent,
              },
            ];
          });
          setIsLoading(false);
          setSessionId(null);
          setAgentStatus(null);
          if (workingDocUri) setDocRefreshKey((k) => k + 1);
        } else if (update.type === "error") {
          setMessages((prev) => [
            ...prev,
            {
              id: `a-${Date.now()}`,
              role: "assistant" as const,
              content: "Something went wrong. Please try again.",
            },
          ]);
          setIsLoading(false);
          setSessionId(null);
          setAgentStatus(null);
        } else if (typeof update.message === "string" && update.type !== "thinking") {
          setAgentStatus(update.message);
        }
      },
      onError: () => {},
    },
  );

  // ── Safety net: poll for completion if the websocket drops ────────

  useEffect(() => {
    if (!sessionId || !conversationId || !isLoading) return;
    const isReconnected = sessionId !== lastStartedSessionRef.current;
    const initialDelay = isReconnected ? 0 : 15_000;

    const recover = async () => {
      try {
        if (completeHandledRef.current) return true;
        const active = await utils.views.knowledge.queryAgent.getActiveSession.fetch({
          conversationId,
        });
        if (!active) {
          if (completeHandledRef.current) return true;
          completeHandledRef.current = true;
          const fresh = await utils.views.knowledge.queryAgent.getConversation.fetch({
            conversationId,
          });
          const freshConv = fresh as unknown as Record<string, any>;
          setMessages(parseAgentMessages(freshConv as never));
          setIsLoading(false);
          setSessionId(null);
          setAgentStatus(null);
          if (freshConv.workingDocumentUri) {
            setWorkingDocUri(freshConv.workingDocumentUri);
            setWorkingDocTitle(freshConv.workingDocumentTitle ?? null);
            setDocRefreshKey((k) => k + 1);
          }
          return true;
        }
        setAgentStatus(active.status);
      } catch {
        // Server unreachable — retry next tick.
      }
      return false;
    };

    let timer: ReturnType<typeof setInterval>;
    const delayTimer = setTimeout(() => {
      void recover();
      timer = setInterval(async () => {
        if (await recover()) clearInterval(timer);
      }, 3000);
    }, initialDelay);
    return () => {
      clearTimeout(delayTimer);
      clearInterval(timer);
    };
  }, [sessionId, conversationId, isLoading, parseAgentMessages, utils]);

  // ── File attachments ───────────────────────────────────────────────

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        const params = new URLSearchParams({
          size: file.size.toString(),
          name: file.name,
        });
        const res = await fetch(`/api/upload_retrievable?${params}`, {
          method: "POST",
          body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" },
        });
        if (!res.ok) continue;
        const { id } = await res.json();
        setPendingFiles((prev) => [...prev, { documentId: id, filename: file.name }]);
      }
    } finally {
      setIsUploading(false);
    }
  }, []);

  const removePendingFile = useCallback((documentId: string) => {
    setPendingFiles((prev) => prev.filter((p) => p.documentId !== documentId));
  }, []);

  // ── Sending ────────────────────────────────────────────────────────

  const cancel = useCallback(() => {
    if (sessionId) cancelAgentMut({ sessionId }).catch(() => {});
  }, [sessionId, cancelAgentMut]);

  const send = useCallback(
    async (overrideMessage?: string) => {
      const text = overrideMessage ?? input.trim();
      if (!text && pendingFiles.length === 0) return;

      // Agent already running → interrupt it and queue this message.
      if (isLoading && sessionId) {
        queuedMessageRef.current = text;
        if (!overrideMessage) setInput("");
        cancelAgentMut({ sessionId }).catch(() => {});
        return;
      }

      const files = pendingFiles;
      const documentIds = files.map((f) => f.documentId);
      if (!overrideMessage) setInput("");
      setPendingFiles([]);

      const newSessionId = `${sessionPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      lastStartedSessionRef.current = newSessionId;
      completeHandledRef.current = false;
      if (getShowModeRef.current?.()) onBuildResetRef.current?.();
      setSessionId(newSessionId);
      setIsLoading(true);
      setAgentStatus(null);

      const userMsg: Message = {
        id: `u-${Date.now()}`,
        role: "user",
        content: text || "What is in the attached file?",
        files: files.length > 0 ? files : undefined,
      };
      setMessages((prev) => [...prev, userMsg]);

      try {
        const result = await sendMessage({
          message: text || "What is in the attached file?",
          sessionId: newSessionId,
          conversationId: conversationId ?? undefined,
          documentIds: documentIds.length > 0 ? documentIds : undefined,
          documentMode,
          ...(pageContext ? { pageContext } : {}),
          ...(getShowModeRef.current?.() ? { showMode: true } : {}),
        });
        if (!conversationId && result.conversationId) {
          setConversationId(result.conversationId);
          void utils.views.knowledge.queryAgent.listAllConversations.invalidate();
          void utils.views.knowledge.queryAgent.listConversations.invalidate();
        }
        // Result arrives via the onUpdate subscription.
      } catch {
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
        setPendingFiles(files);
        setIsLoading(false);
        setSessionId(null);
        setAgentStatus(null);
      }
    },
    [
      input,
      pendingFiles,
      isLoading,
      sessionId,
      sendMessage,
      cancelAgentMut,
      conversationId,
      documentMode,
      pageContext,
      sessionPrefix,
      setConversationId,
      utils,
    ],
  );

  // Auto-send a queued message once the interrupted turn settles.
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    if (prevLoadingRef.current && !isLoading) {
      const queued = queuedMessageRef.current;
      if (queued) {
        queuedMessageRef.current = null;
        void send(queued);
      }
    }
    prevLoadingRef.current = isLoading;
  }, [isLoading, send]);

  // ── Conversation switching ─────────────────────────────────────────

  const newChat = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    setLegacyDomain(null);
    setSessionId(null);
    setIsLoading(false);
    setInput("");
    setAgentStatus(null);
    setActiveAgent("unified");
    setWorkingDocUri(null);
    setWorkingDocTitle(null);
    setDocumentModeRaw("collaborating");
    setPendingFiles([]);
    queuedMessageRef.current = null;
  }, [setConversationId]);

  const openConversation = useCallback(
    async (id: string, opts?: { legacyDomain?: string | null }) => {
      if (id === conversationId) return;
      setMessages([]);
      setConversationId(id);
      setLegacyDomain(opts?.legacyDomain ?? null);
      setSessionId(null);
      setIsLoading(false);
      setAgentStatus(null);
      setActiveAgent("unified");
      setWorkingDocUri(null);
      setWorkingDocTitle(null);
      setDocumentModeRaw("collaborating");
      setPendingFiles([]);
      queuedMessageRef.current = null;
      try {
        await utils.views.knowledge.queryAgent.getConversation.invalidate({
          conversationId: id,
        });
        const fresh = await utils.views.knowledge.queryAgent.getConversation.fetch({
          conversationId: id,
        });
        const conv = fresh as unknown as Record<string, any>;
        setMessages(parseAgentMessages(conv as never));
        if (conv.activeAgent) setActiveAgent(conv.activeAgent);
        if (conv.workingDocumentUri) {
          setWorkingDocUri(conv.workingDocumentUri);
          setWorkingDocTitle(conv.workingDocumentTitle ?? null);
        }
        if (conv.documentMode === "input" || conv.documentMode === "collaborating") {
          setDocumentModeRaw(conv.documentMode);
        }
        // Reattach if a turn is still running for this conversation.
        const active = await utils.views.knowledge.queryAgent.getActiveSession.fetch({
          conversationId: id,
        });
        if (active) {
          completeHandledRef.current = false;
          setSessionId(active.sessionId);
          setIsLoading(true);
          setAgentStatus(active.status);
        }
      } catch {
        setMessages([
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            content: "Couldn't load this conversation. Please try again.",
          },
        ]);
      }
    },
    [conversationId, parseAgentMessages, utils, setConversationId],
  );

  // ── Working document actions ───────────────────────────────────────

  const createWorkingDocument = useCallback(async () => {
    if (!conversationId) return;
    try {
      await createDoc({ conversationId, content: "", title: "Working Document" });
      setWorkingDocUri("pending");
      setWorkingDocTitle("Working Document");
      setDocRefreshKey((k) => k + 1);
    } catch (e) {
      console.error("Failed to create working document:", e);
    }
  }, [conversationId, createDoc]);

  const onWorkingDocumentDiscarded = useCallback(() => {
    setWorkingDocUri(null);
    setWorkingDocTitle(null);
  }, []);

  return {
    // chat state
    messages,
    input,
    setInput,
    isLoading,
    agentStatus,
    conversationId,
    legacyDomain,
    activeAgent,
    // actions
    send,
    cancel,
    newChat,
    openConversation,
    // attachments
    pendingFiles,
    isUploading,
    uploadFiles,
    removePendingFile,
    // working document
    documentMode,
    setDocumentMode,
    workingDocUri,
    workingDocTitle,
    docRefreshKey,
    createWorkingDocument,
    onWorkingDocumentDiscarded,
  };
}

export type AssistantChat = ReturnType<typeof useAssistantChat>;
