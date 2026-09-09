"use client";

/**
 * Conversation history list — shared by the panel's history view and
 * the /ask page's sidebar. Shows every web conversation across the
 * retired per-domain agents; legacy ones carry an origin badge and
 * resume seamlessly in the unified agent.
 */

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { formatRelativeTime, type ConversationListItem } from "./types";

export function useConversationList(enabled: boolean) {
  return trpc.views.knowledge.queryAgent.listAllConversations.useQuery(undefined, {
    enabled,
    refetchOnWindowFocus: false,
  }) as {
    data: ConversationListItem[] | undefined;
    isLoading: boolean;
  };
}

export function ConversationHistory({
  enabled,
  activeConversationId,
  onSelect,
}: {
  enabled: boolean;
  activeConversationId: string | null;
  onSelect: (conv: ConversationListItem) => void;
}) {
  const { data: conversations, isLoading } = useConversationList(enabled);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!conversations) return [];
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) =>
      `${c.title ?? ""} ${c.preview ?? ""} ${c.legacyDomain ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [conversations, search]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pb-2 pt-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search conversations…"
          className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2 text-[13px] placeholder:text-gray-400 focus:border-primary/40 focus:bg-white focus:outline-none focus:ring-1 focus:ring-primary/20"
        />
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {isLoading ? (
          <div className="space-y-2 px-2 pt-2">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-gray-100" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-3 pt-8 text-center text-[12px] text-gray-400">
            {search ? "No conversations match." : "No conversations yet."}
          </p>
        ) : (
          filtered.map((conv) => (
            <button
              key={conv.id}
              onClick={() => onSelect(conv)}
              className={`cursor-pointer mb-0.5 w-full rounded-xl px-3 py-2.5 text-left transition-colors ${
                conv.id === activeConversationId
                  ? "bg-primary-50"
                  : "hover:bg-gray-50"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="line-clamp-1 flex-1 text-[13px] font-medium text-gray-800">
                  {conv.title || conv.preview || "Untitled"}
                </span>
                {conv.legacyDomain && (
                  <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    {conv.legacyDomain}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                <span className="line-clamp-1 flex-1 text-[12px] text-gray-400">
                  {conv.preview ?? ""}
                </span>
                <span className="shrink-0 text-[11px] text-gray-300">
                  {formatRelativeTime(conv.updatedAt)}
                </span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
