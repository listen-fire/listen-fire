"use client";

/**
 * Message rendering for the assistant — shared by both presentations.
 * Assistant turns get markdown, agent-generated attachment cards, and
 * the "How I found this" provenance footer (entities, steps, sources).
 * User turns show attachment chips for any files sent with that turn.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Download,
  FileText,
  Paperclip,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { AssistantIcon } from "@/components/icons";
import { AgentMarkdown } from "@/components/agent-markdown";
import type {
  AttachmentRef,
  EntityRef,
  Message,
  SuggestedAction,
  ToolTraceEntry,
} from "./types";

// ── Copy ─────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="cursor-pointer flex items-center gap-1 text-[11px] text-gray-400 transition-colors hover:text-gray-600"
    >
      {copied ? (
        <>
          <Check size={12} />
          Copied
        </>
      ) : (
        <>
          <Copy size={12} />
          Copy
        </>
      )}
    </button>
  );
}

// ── Provenance ───────────────────────────────────────────────────────

function collectEntities(trace: ToolTraceEntry[]): EntityRef[] {
  const seen = new Set<string>();
  const unique: EntityRef[] = [];

  for (const t of trace) {
    if (t.tool === "getNodeDetail" && t.metadata?.nodeId && t.metadata?.nodeTypeId) {
      if (!seen.has(t.metadata.nodeId)) {
        seen.add(t.metadata.nodeId);
        unique.push({
          nodeId: t.metadata.nodeId,
          nodeTypeId: t.metadata.nodeTypeId,
          nodeTypeName: t.metadata.nodeTypeName,
          category: t.metadata.category,
          summary: t.metadata.summary,
          displayName: t.metadata.displayName,
          rawText: t.metadata.rawText,
        });
      }
    }
    if ((t.tool === "queryKnowledgeGraph" || t.tool === "queryGraph") && t.metadata?.entities) {
      for (const entity of t.metadata.entities) {
        if (!seen.has(entity.nodeId)) {
          seen.add(entity.nodeId);
          unique.push(entity);
        }
      }
    }
  }
  return unique;
}

function EntityChips({
  trace,
  onEntityClick,
}: {
  trace: ToolTraceEntry[];
  onEntityClick: (nodeId: string) => void;
}) {
  const unique = collectEntities(trace);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);

  if (unique.length === 0) return null;

  const expandedEntity = unique.find((e) => e.nodeId === expandedNodeId);

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {unique.slice(0, 10).map((entity) => {
          const isMessage = entity.category === "message" && entity.rawText;
          const isExpanded = expandedNodeId === entity.nodeId;
          return (
            <button
              key={entity.nodeId}
              onClick={() => {
                if (isMessage) {
                  setExpandedNodeId((prev) =>
                    prev === entity.nodeId ? null : entity.nodeId,
                  );
                } else {
                  onEntityClick(entity.nodeId);
                }
              }}
              className={`cursor-pointer inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                isExpanded
                  ? "bg-primary/10 text-primary"
                  : "bg-gray-100 text-gray-600 hover:bg-primary/10 hover:text-primary"
              }`}
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              {entity.displayName ?? entity.nodeTypeName ?? "Entity"}
            </button>
          );
        })}
      </div>

      {expandedEntity?.rawText && (
        <div className="mt-2 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] leading-relaxed text-gray-600 whitespace-pre-wrap">
          {expandedEntity.rawText}
        </div>
      )}
    </div>
  );
}

function resourceTypeIcon(type: string) {
  if (type === "EMAIL") return "✉";
  if (type === "URL") return "🌐";
  if (type === "FILE") return "📄";
  if (type === "WHATSAPP") return "💬";
  return "📄";
}

function SourceLinks({ trace }: { trace: ToolTraceEntry[] }) {
  const allSources = trace
    .filter((t) => t.metadata?.sources?.length)
    .flatMap((t) => t.metadata!.sources!);

  const seen = new Set<string>();
  const unique = allSources.filter((s) => {
    if (seen.has(s.resourceId)) return false;
    seen.add(s.resourceId);
    return true;
  });

  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (unique.length === 0) return null;

  return (
    <div className="space-y-1">
      <span className="text-[11px] font-medium uppercase text-gray-400">
        Sources
      </span>
      {unique.slice(0, 5).map((source) => {
        const canExpand = !!source.rawText;
        const isExpanded = expandedId === source.resourceId;
        return (
          <div key={source.resourceId}>
            <div className="flex items-center gap-2 rounded-md border border-gray-100 bg-gray-50/50 px-3 py-1.5">
              <span className="text-[12px]">
                {resourceTypeIcon(source.resourceType)}
              </span>
              <span className="truncate text-[12px] text-gray-600">
                {source.resourceName}
              </span>
              {source.resourceUrl ? (
                <a
                  href={source.resourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto shrink-0 text-[11px] font-medium text-primary hover:underline"
                >
                  Open
                </a>
              ) : canExpand ? (
                <button
                  onClick={() =>
                    setExpandedId((prev) =>
                      prev === source.resourceId ? null : source.resourceId,
                    )
                  }
                  className="cursor-pointer ml-auto shrink-0 text-[11px] font-medium text-primary hover:underline"
                >
                  {isExpanded ? "Hide" : "View"}
                </button>
              ) : null}
            </div>
            {isExpanded && source.rawText && (
              <div className="mt-1 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] leading-relaxed text-gray-600 whitespace-pre-wrap">
                {source.rawText}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function describeStep(step: ToolTraceEntry): string | null {
  const args = step.args as Record<string, unknown> | undefined;
  if (step.tool === "queryKnowledgeGraph" || step.tool === "queryGraph") {
    const question = (args?.question ?? args?.query) as string | undefined;
    const entities = step.metadata?.entities;
    const count = entities?.length ?? 0;
    if (count > 0) {
      const typeNames = [
        ...new Set(entities!.map((e) => e.nodeTypeName).filter(Boolean)),
      ];
      const typePart = typeNames.length > 0 ? typeNames.join(", ") : "results";
      return `Queried "${question}" — ${count} ${typePart}`;
    }
    if (question) return `Searched your data`;
    return "Searched your data";
  }
  if (step.tool === "searchFactStore") {
    const query = args?.query as string | undefined;
    if (query) return `Searched facts for "${query}"`;
    return "Searched fact store";
  }
  if (step.tool === "getNodeDetail") {
    const name = step.metadata?.displayName ?? step.metadata?.nodeTypeName;
    if (name) return `Looked up ${name}`;
    return "Looked up entity details";
  }
  if (step.tool === "webSearch") {
    const query = args?.query as string | undefined;
    const count = step.metadata?.webResults?.length ?? 0;
    if (query) return `Web search: "${query}" (${count} results)`;
    return `Web search (${count} results)`;
  }
  if (step.tool === "readUploadedFile") {
    return "Read an attached file";
  }
  return null;
}

const PROVENANCE_TOOLS = new Set([
  "queryKnowledgeGraph",
  "queryGraph",
  "getNodeDetail",
  "searchFactStore",
  "webSearch",
  "readUploadedFile",
]);

function ProvenanceFooter({
  trace,
  onEntityClick,
  actions,
}: {
  trace: ToolTraceEntry[];
  onEntityClick: (nodeId: string) => void;
  actions?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  const meaningfulSteps = trace.filter((t) => PROVENANCE_TOOLS.has(t.tool));

  if (meaningfulSteps.length === 0) return null;

  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setExpanded(!expanded)}
          className="cursor-pointer flex items-center gap-1 text-[11px] font-medium text-gray-400 transition-colors hover:text-gray-600"
        >
          <svg
            className="h-3 w-3 transition-transform"
            style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          How I found this
        </button>
        {actions}
      </div>

      {expanded && (
        <div className="mt-2 flex flex-col gap-3">
          <EntityChips trace={trace} onEntityClick={onEntityClick} />

          {meaningfulSteps.map((step, i) => {
            const description = describeStep(step);
            if (!description) return null;
            const webResults = step.metadata?.webResults;
            return (
              <div
                key={i}
                className="rounded-md border border-gray-100 bg-gray-50/50 px-3 py-2"
              >
                <p className="text-[12px] text-gray-600">{description}</p>
                {webResults && webResults.length > 0 && (
                  <div className="mt-1.5 flex flex-col gap-1">
                    {webResults.map((wr, j) => (
                      <a
                        key={j}
                        href={wr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate text-[11px] text-primary hover:underline"
                        title={wr.snippet}
                      >
                        {wr.title}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          <SourceLinks trace={trace} />
        </div>
      )}
    </div>
  );
}

// ── Attachments ──────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentCards({ attachments }: { attachments: AttachmentRef[] }) {
  const utils = trpc.useUtils();

  if (attachments.length === 0) return null;

  const handleDownload = async (objectUri: string) => {
    const { downloadUrl } =
      await utils.views.knowledge.queryAgent.getAttachmentUrl.fetch({ objectUri });
    window.open(downloadUrl, "_blank");
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      {attachments.map((att, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50/50 px-3 py-2.5"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gray-200">
            <FileText size={14} className="text-gray-500" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-gray-800">
              {att.title}
            </div>
            <div className="text-[11px] text-gray-400">
              {att.format.toUpperCase()} &middot; {formatBytes(att.sizeBytes)}
            </div>
          </div>
          <button
            onClick={() => handleDownload(att.objectUri)}
            className="cursor-pointer flex shrink-0 items-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[12px] font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
          >
            <Download size={12} />
            Download
          </button>
        </div>
      ))}
    </div>
  );
}

/** Chips for files the user attached to a turn. */
function UserFileChips({ files }: { files: { documentId: string; filename: string }[] }) {
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {files.map((f) => (
        <span
          key={f.documentId}
          className="inline-flex items-center gap-1 rounded-md bg-white/60 px-2 py-0.5 text-[11px] font-medium text-gray-600 ring-1 ring-gray-200"
        >
          <Paperclip size={10} className="text-gray-400" />
          {f.filename}
        </span>
      ))}
    </div>
  );
}

// ── Message list ─────────────────────────────────────────────────────

export function MessageList({
  messages,
  isLoading,
  agentStatus,
  onSuggestedAction,
  onEntityClick,
  emptyTitle = "Ask about anything",
  emptyCaption = "Your data, your automations, your files — the assistant can read what you attach.",
}: {
  messages: Message[];
  isLoading: boolean;
  agentStatus: string | null;
  onSuggestedAction: (action: SuggestedAction) => void;
  onEntityClick: (nodeId: string) => void;
  emptyTitle?: string;
  emptyCaption?: string;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, agentStatus, isLoading]);

  return (
    <div className="space-y-3">
      {messages.length === 0 && !isLoading && (
        <div className="flex flex-col items-center gap-4 pt-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50">
            <AssistantIcon className="h-[22px] w-[22px] text-primary-400" />
          </div>
          <div>
            <p className="text-[14px] font-medium text-gray-900">{emptyTitle}</p>
            <p className="mx-auto mt-1.5 max-w-[300px] text-[12.5px] leading-relaxed text-gray-400">
              {emptyCaption}
            </p>
          </div>
        </div>
      )}

      {messages.map((msg, idx) => {
        if (msg.role === "system") {
          return (
            <div key={msg.id} className="flex items-center gap-3 py-1">
              <div className="h-px flex-1 bg-gray-100" />
              <span className="shrink-0 text-[11px] font-medium text-gray-400">
                {msg.content}
              </span>
              <div className="h-px flex-1 bg-gray-100" />
            </div>
          );
        }

        const isLastAssistant =
          msg.role === "assistant" && idx === messages.length - 1;
        const showActions =
          isLastAssistant &&
          !isLoading &&
          msg.suggestedActions &&
          msg.suggestedActions.length > 0;
        const showAgentTag =
          msg.role === "assistant" &&
          msg.agent &&
          msg.agent !== "query" &&
          msg.agent !== "unified";

        return (
          <div key={msg.id}>
            <div
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[88%] overflow-hidden rounded-xl px-3.5 py-2.5 ${
                  msg.role === "user"
                    ? "bg-primary/10 text-gray-800"
                    : "bg-white text-gray-700 shadow-sm ring-1 ring-gray-100"
                }`}
              >
                {msg.role === "assistant" ? (
                  <>
                    {showAgentTag && (
                      <div className="mb-2 flex items-center gap-1.5">
                        <span className="inline-flex items-center rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                          {msg.agent}
                        </span>
                      </div>
                    )}
                    <div className="prose prose-sm max-w-none text-[13px] prose-headings:text-gray-900">
                      <AgentMarkdown content={msg.content} />
                    </div>
                    {msg.attachments && msg.attachments.length > 0 && (
                      <AttachmentCards attachments={msg.attachments} />
                    )}
                    {msg.trace && msg.trace.length > 0 ? (
                      <ProvenanceFooter
                        trace={msg.trace}
                        onEntityClick={onEntityClick}
                        actions={<CopyButton text={msg.content} />}
                      />
                    ) : (
                      <div className="mt-2 flex justify-end border-t border-gray-100 pt-2">
                        <CopyButton text={msg.content} />
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {msg.files && msg.files.length > 0 && (
                      <UserFileChips files={msg.files} />
                    )}
                    <p className="whitespace-pre-wrap text-[13px]">{msg.content}</p>
                  </>
                )}
              </div>
            </div>
            {showActions && (
              <div className="mt-2 flex flex-wrap gap-2">
                {msg.suggestedActions!.map((action) => (
                  <button
                    key={action.label}
                    onClick={() => onSuggestedAction(action)}
                    className="cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[13px] font-medium text-gray-700 shadow-sm transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {isLoading && (
        <div className="flex min-w-0 items-center gap-2 px-1 py-1">
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/40" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary/70" />
          </span>
          <p className="min-w-0 flex-1 truncate text-[12px] text-gray-400">
            {agentStatus ?? "Working on it…"}
          </p>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}
