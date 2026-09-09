// evidence popover for sidebar
"use client";

import { useState, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";

const TYPE_STYLES: Record<string, string> = {
  extraction: "bg-blue-100 text-blue-700",
  user_edit: "bg-purple-100 text-purple-700",
  retrieval: "bg-green-100 text-green-700",
  input_mapping: "bg-gray-100 text-gray-600",
};

const TYPE_LABELS: Record<string, string> = {
  extraction: "Extraction",
  user_edit: "User edit",
  retrieval: "Retrieval",
  input_mapping: "Input mapping",
};

function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function EvidenceIndicator({
  propertyId,
}: {
  propertyId: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-blue-50"
        title="View evidence"
      >
        <svg
          className="h-2.5 w-2.5 text-blue-400"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <circle cx="12" cy="12" r="6" />
        </svg>
      </button>
      {open && (
        <EvidencePopoverContent propertyId={propertyId} />
      )}
    </div>
  );
}

function EvidencePopoverContent({ propertyId }: { propertyId: string }) {
  const { data: evidence, isLoading } =
    trpc.views.knowledge.graph.getPropertyEvidence.useQuery({ propertyId });

  return (
    <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg">
      <div className="border-b border-gray-100 px-3 py-2">
        <h4 className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
          Evidence
        </h4>
      </div>
      <div className="max-h-64 overflow-y-auto p-2">
        {isLoading ? (
          <div className="space-y-2 p-1">
            {[1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded bg-gray-50" />
            ))}
          </div>
        ) : evidence && evidence.length > 0 ? (
          <div className="space-y-1.5">
            {evidence.map((ev) => (
              <div
                key={ev.id}
                className="rounded-md border border-gray-100 bg-gray-50/50 px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${TYPE_STYLES[ev.type] ?? "bg-gray-100 text-gray-600"}`}
                  >
                    {TYPE_LABELS[ev.type] ?? ev.type}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {timeAgo(ev.created_at)}
                  </span>
                </div>
                {ev.description && (
                  <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-gray-600">
                    {ev.description}
                  </p>
                )}
                {ev.excerpt && (
                  <p className="mt-1 line-clamp-2 border-l-2 border-gray-200 pl-2 text-[11px] italic text-gray-400">
                    {ev.excerpt}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="py-2 text-center text-[11px] italic text-gray-400">
            No evidence
          </p>
        )}
      </div>
    </div>
  );
}
