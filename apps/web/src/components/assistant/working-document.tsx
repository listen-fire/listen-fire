"use client";

/**
 * Working document side panel — a markdown document the user and agent
 * co-author within a conversation. Page presentation only (needs the
 * horizontal space).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { AgentMarkdown } from "@/components/agent-markdown";

export function WorkingDocumentPanel({
  conversationId,
  title,
  refreshKey,
  onDiscard,
}: {
  conversationId: string;
  title: string | null;
  refreshKey: number;
  onDiscard?: () => void;
}) {
  const { data, isLoading, refetch } =
    trpc.views.knowledge.queryAgent.getWorkingDocument.useQuery(
      { conversationId },
      { refetchOnWindowFocus: false },
    );
  const { mutateAsync: save } =
    trpc.views.knowledge.queryAgent.updateWorkingDocument.useMutation();
  const { mutateAsync: discard } =
    trpc.views.knowledge.queryAgent.discardWorkingDocument.useMutation();

  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [localContent, setLocalContent] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevRefreshKey = useRef(refreshKey);

  // Re-fetch from server when agent updates the document
  useEffect(() => {
    if (refreshKey !== prevRefreshKey.current) {
      prevRefreshKey.current = refreshKey;
      refetch();
    }
  }, [refreshKey, refetch]);

  // Sync local content from server data
  useEffect(() => {
    if (data) setLocalContent(data.content);
  }, [data]);

  const handleChange = useCallback(
    (value: string) => {
      setLocalContent(value);
      setSaveStatus("saving");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        save({ conversationId, content: value })
          .then(() => {
            setSaveStatus("saved");
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
            savedTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
          })
          .catch(() => setSaveStatus("idle"));
      }, 1000);
    },
    [conversationId, save],
  );

  // Cleanup timers
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);


  const handleDiscard = useCallback(async () => {
    try {
      await discard({ conversationId });
      onDiscard?.();
    } catch (e) {
      console.error("Failed to discard working document:", e);
    }
  }, [conversationId, discard, onDiscard]);

  const content = localContent ?? data?.content ?? "";

  return (
    <div className="flex h-full flex-col border-l border-gray-200 bg-white">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-100 px-4">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium text-gray-700 truncate">
            {title ?? "Working Document"}
          </span>
          {saveStatus === "saving" && (
            <span className="shrink-0 text-[11px] text-gray-400">Saving...</span>
          )}
          {saveStatus === "saved" && (
            <span className="shrink-0 text-[11px] text-green-500">Saved</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-gray-200">
            <button
              onClick={() => setMode("edit")}
              className={`cursor-pointer px-2 py-0.5 text-[11px] font-medium transition-colors ${
                mode === "edit"
                  ? "bg-gray-100 text-gray-700"
                  : "text-gray-400 hover:text-gray-600"
              }`}
            >
              Edit
            </button>
            <button
              onClick={() => setMode("preview")}
              className={`cursor-pointer px-2 py-0.5 text-[11px] font-medium transition-colors ${
                mode === "preview"
                  ? "bg-gray-100 text-gray-700"
                  : "text-gray-400 hover:text-gray-600"
              }`}
            >
              Preview
            </button>
          </div>
          <button
            onClick={handleDiscard}
            className="cursor-pointer flex h-6 w-6 items-center justify-center rounded text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
            title="Discard document"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>
      {isLoading && !localContent ? (
        <div className="flex-1 p-4">
          <div className="h-4 w-3/4 animate-pulse rounded bg-gray-100" />
          <div className="mt-2 h-4 w-1/2 animate-pulse rounded bg-gray-100" />
        </div>
      ) : mode === "edit" ? (
        <textarea
          className="flex-1 resize-none border-0 bg-white px-5 py-5 text-[14px] leading-[1.75] text-gray-800 placeholder:text-gray-400 focus:outline-none font-mono"
          value={content}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="The agent will write here as ideas are committed..."
        />
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="prose prose-sm max-w-none prose-headings:text-gray-900">
            <AgentMarkdown content={content} />
          </div>
        </div>
      )}
    </div>
  );
}
