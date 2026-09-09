"use client";

/**
 * Entity detail overlay opened from provenance chips — fetches the
 * ontology summary on demand and renders the standard node drawer
 * above whichever presentation is active.
 */

import { trpc } from "@/lib/trpc";
import { NodeDetailDrawer } from "@/components/objects/node-detail-drawer";

export function AssistantEntityDrawer({
  nodeId,
  onClose,
  onNavigate,
}: {
  nodeId: string | null;
  onClose: () => void;
  onNavigate: (nodeId: string) => void;
}) {
  const { data: ontology } =
    trpc.views.knowledge.ontology.getOntologySummary.useQuery(undefined, {
      enabled: !!nodeId,
    });

  if (!nodeId) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-[60] w-full border-l border-gray-200 bg-white shadow-xl sm:w-[420px]">
      <NodeDetailDrawer
        nodeId={nodeId}
        onClose={onClose}
        onNavigate={onNavigate}
        ontology={ontology}
      />
    </div>
  );
}
