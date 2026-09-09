"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Modal } from "./modal";
import { Select } from "@/components/select";

const inputClass =
  "w-full rounded-md border border-gray-200 px-3 py-2 text-[13px] focus:border-gray-400 focus:outline-none";

export function CreateEdgeGroupModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceNodeTypeId, setSourceNodeTypeId] = useState("");
  const [targetNodeTypeIds, setTargetNodeTypeIds] = useState<string[]>([]);
  const [required, setRequired] = useState(false);
  const [scopes, setScopes] = useState(false);

  const { data: nodeTypes } =
    trpc.views.knowledge.ontology.getNodeTypes.useQuery();
  const utils = trpc.useUtils();
  const { mutateAsync: createEdgeGroup, isLoading } =
    trpc.views.knowledge.ontology.createEdgeGroup.useMutation();

  const toggleTarget = (id: string) => {
    setTargetNodeTypeIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleSubmit = async () => {
    await createEdgeGroup({
      name,
      description,
      sourceNodeTypeId,
      targetNodeTypeIds,
      required,
      scopes,
    });
    utils.views.knowledge.ontology.getOntologySummary.invalidate();
    setName("");
    setDescription("");
    setSourceNodeTypeId("");
    setTargetNodeTypeIds([]);
    setRequired(false);
    setScopes(false);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Relationship Group">
      <div className="flex flex-col gap-3 p-5">
        <div>
          <label className="mb-1 block text-[12px] font-medium text-gray-600">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. mentions, invested_by"
            className={inputClass}
          />
          {name && targetNodeTypeIds.length > 0 && nodeTypes && (
            <p className="mt-1 text-[11px] text-gray-400">
              Creates:{" "}
              {targetNodeTypeIds
                .map((id) => {
                  const nt = nodeTypes.find((n) => n.id === id);
                  return `${name}_${(nt?.name ?? "").toLowerCase().replace(/ /g, "_")}`;
                })
                .join(", ")}
            </p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-gray-600">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Shared description for all edges in this group"
            rows={2}
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-gray-600">
            From
          </label>
          <Select
            value={sourceNodeTypeId}
            onChange={setSourceNodeTypeId}
            placeholder="Select type..."
            options={(nodeTypes ?? []).map((nt) => ({
              label: nt.name,
              value: nt.id,
            }))}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-gray-600">
            To
          </label>
          <div className="flex flex-col gap-1">
            {nodeTypes?.map((nt) => (
              <label
                key={nt.id}
                className="flex items-center gap-2 text-[12px] text-gray-700"
              >
                <input
                  type="checkbox"
                  checked={targetNodeTypeIds.includes(nt.id)}
                  onChange={() => toggleTarget(nt.id)}
                  className="rounded border-gray-300"
                />
                {nt.name}
              </label>
            ))}
          </div>
        </div>
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-[12px] text-gray-700">
            <input
              type="checkbox"
              checked={scopes}
              onChange={(e) => setScopes(e.target.checked)}
              className="rounded border-gray-300"
            />
            Defines scope
          </label>
          <label className="flex items-center gap-2 text-[12px] text-gray-700">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
              className="rounded border-gray-300"
            />
            Required
          </label>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3.5">
        <button
          onClick={onClose}
          className="rounded-md px-3 py-1.5 text-[13px] text-gray-500 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={
            !name.trim() ||
            !sourceNodeTypeId ||
            targetNodeTypeIds.length === 0 ||
            isLoading
          }
          className="rounded-md bg-primary px-4 py-1.5 text-[13px] font-medium text-white hover:bg-primary-600 disabled:opacity-40"
        >
          {isLoading ? "Creating..." : "Create"}
        </button>
      </div>
    </Modal>
  );
}
