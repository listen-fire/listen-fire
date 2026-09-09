// changelog section for full pages
"use client";

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";

const SOURCE_STYLES: Record<string, string> = {
  pipeline: "bg-blue-100 text-blue-700",
  user_edit: "bg-purple-100 text-purple-700",
  agent: "bg-amber-100 text-amber-700",
  api: "bg-gray-100 text-gray-600",
  mcp: "bg-green-100 text-green-700",
};

const SOURCE_LABELS: Record<string, string> = {
  pipeline: "Pipeline",
  user_edit: "User edit",
  agent: "Agent",
  api: "API",
  mcp: "MCP",
};

function formatDate(date: Date | string) {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type ChangeRecord = {
  id: string;
  request_id: string;
  source: string;
  kind: string;
  property_id: string | null;
  property_name: string | null;
  edge_id: string | null;
  evidence_id: string | null;
  old_value: unknown;
  new_value: unknown;
  created_by_name: string | null;
  created_at: Date | string;
};

type ChangeGroup = {
  requestId: string;
  source: string;
  timestamp: Date | string;
  createdByName: string | null;
  changes: ChangeRecord[];
};

function groupByRequestId(changes: ChangeRecord[]): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();
  for (const change of changes) {
    let group = groups.get(change.request_id);
    if (!group) {
      group = {
        requestId: change.request_id,
        source: change.source,
        timestamp: change.created_at,
        createdByName: change.created_by_name,
        changes: [],
      };
      groups.set(change.request_id, group);
    }
    group.changes.push(change);
  }
  return Array.from(groups.values());
}

function formatChangeValue(val: unknown): string {
  if (val === null || val === undefined) return "\u2014";
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if (obj.text !== undefined) return String(obj.text);
    if (obj.number !== undefined) return String(obj.number);
    if (obj.boolean !== undefined) return obj.boolean ? "Yes" : "No";
    if (obj.date !== undefined) {
      return new Date(obj.date as string).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }
    if (obj.json !== undefined) return JSON.stringify(obj.json);
  }
  return String(val);
}

const LARGE_VALUE_THRESHOLD = 60;

function isLargeValue(val: unknown): boolean {
  return formatChangeValue(val).length > LARGE_VALUE_THRESHOLD;
}

function ChangeDetail({ change }: { change: ChangeRecord }) {
  const [expanded, setExpanded] = useState(false);
  const name = change.property_name ?? "property";
  const oldStr = formatChangeValue(change.old_value);
  const newStr = formatChangeValue(change.new_value);
  const isLarge = isLargeValue(change.old_value) || isLargeValue(change.new_value);

  if (change.kind === "property_cleared") {
    return <span className="text-[12px] text-gray-600">Cleared {name}</span>;
  }
  if (change.kind === "node_created") {
    return <span className="text-[12px] text-gray-600">Created node</span>;
  }
  if (change.kind === "node_removed") {
    return <span className="text-[12px] text-gray-600">Removed node</span>;
  }
  if (change.kind === "edge_created") {
    return <span className="text-[12px] text-gray-600">Created relationship</span>;
  }
  if (change.kind === "edge_removed") {
    return <span className="text-[12px] text-gray-600">Removed relationship</span>;
  }

  if (isLarge) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-[12px] text-gray-600 hover:text-gray-800"
        >
          <svg
            className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span className="font-medium">{name}</span>
          <span className="text-gray-400">
            {oldStr === "\u2014" ? "(set)" : "(changed)"}
          </span>
        </button>
        {expanded && (
          <div className="ml-4 mt-1.5 space-y-1">
            {oldStr !== "\u2014" && (
              <div className="rounded bg-red-50 px-2 py-1">
                <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-red-700">
                  {oldStr}
                </p>
              </div>
            )}
            <div className="rounded bg-green-50 px-2 py-1">
              <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-green-700">
                {newStr}
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (oldStr === "\u2014") {
    return (
      <span className="text-[12px] text-gray-600">
        Set <span className="font-medium">{name}</span> to{" "}
        <span className="whitespace-nowrap text-gray-900">{newStr}</span>
      </span>
    );
  }

  return (
    <span className="text-[12px] text-gray-600">
      <span className="font-medium">{name}</span>:{" "}
      <span className="whitespace-nowrap text-gray-400 line-through">{oldStr}</span>
      {" \u2192 "}
      <span className="whitespace-nowrap text-gray-900">{newStr}</span>
    </span>
  );
}

function ChangeGroupCard({ group }: { group: ChangeGroup }) {
  const [expanded, setExpanded] = useState(group.changes.length <= 3);

  const summary = useMemo(() => {
    const nodeCreated = group.changes.find((c) => c.kind === "node_created");
    const propSets = group.changes.filter((c) => c.kind === "property_set");

    if (nodeCreated && propSets.length > 0) {
      return `Created node and set ${propSets.length} ${propSets.length === 1 ? "property" : "properties"}`;
    }
    if (nodeCreated) return "Created node";
    if (propSets.length === 1) {
      const name = propSets[0]!.property_name ?? "property";
      const isLarge = isLargeValue(propSets[0]!.old_value) || isLargeValue(propSets[0]!.new_value);
      if (isLarge) {
        const oldStr = formatChangeValue(propSets[0]!.old_value);
        return oldStr === "\u2014" ? `Set ${name}` : `Updated ${name}`;
      }
      const oldStr = formatChangeValue(propSets[0]!.old_value);
      const newStr = formatChangeValue(propSets[0]!.new_value);
      if (oldStr === "\u2014") return `Set ${name} to ${newStr}`;
      return `${name}: ${oldStr} \u2192 ${newStr}`;
    }
    if (propSets.length > 0) return `Updated ${propSets.length} properties`;
    return `${group.changes.length} ${group.changes.length === 1 ? "change" : "changes"}`;
  }, [group.changes]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div
        className="flex cursor-pointer items-start justify-between gap-2 px-4 py-2.5"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${SOURCE_STYLES[group.source] ?? "bg-gray-100 text-gray-600"}`}
          >
            {SOURCE_LABELS[group.source] ?? group.source}
          </span>
          <span className="min-w-0 truncate text-[12px] text-gray-700">{summary}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {group.createdByName && (
            <span className="text-[10px] text-gray-400">{group.createdByName}</span>
          )}
          <span className="whitespace-nowrap text-[11px] text-gray-400">
            {formatDate(group.timestamp)}
          </span>
          <svg
            className={`h-3 w-3 shrink-0 text-gray-400 transition-transform ${expanded ? "rotate-90" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-gray-100 px-4 py-2">
          {group.changes.map((change) => (
            <div key={change.id} className="py-1">
              <ChangeDetail change={change} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChangelogSection({
  nodeId,
  edgeId,
}: {
  nodeId?: string;
  edgeId?: string;
}) {
  const nodeChanges = trpc.views.knowledge.graph.getNodeChanges.useQuery(
    { nodeId: nodeId! },
    { enabled: !!nodeId },
  );
  const edgeChanges = trpc.views.knowledge.graph.getEdgeChanges.useQuery(
    { edgeId: edgeId! },
    { enabled: !!edgeId },
  );

  const result = nodeId ? nodeChanges : edgeChanges;
  const groups = useMemo(
    () => groupByRequestId((result.data?.changes as ChangeRecord[]) ?? []),
    [result.data],
  );

  return (
    <section>
      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-gray-400">
        Changelog
      </h2>
      {result.isLoading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-gray-50" />
          ))}
        </div>
      ) : groups.length > 0 ? (
        <div className="space-y-2">
          {groups.map((group) => (
            <ChangeGroupCard key={group.requestId} group={group} />
          ))}
          {result.data?.nextCursor && (
            <button className="w-full rounded-lg border border-gray-200 py-2 text-center text-[12px] text-gray-500 transition-colors hover:bg-gray-50">
              Load more
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-center">
          <p className="text-[13px] italic text-gray-400">No changes recorded yet</p>
        </div>
      )}
    </section>
  );
}
