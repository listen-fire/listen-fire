"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Modal } from "./modal";
import { Select } from "@/components/select";

const inputClass =
  "w-full rounded-md border border-gray-200 px-3 py-2 text-[13px] focus:border-gray-400 focus:outline-none";

export function CreateEdgeTypeModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [outboundName, setOutboundName] = useState("");
  const [inboundName, setInboundName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceNodeTypeId, setSourceNodeTypeId] = useState("");
  const [targetNodeTypeId, setTargetNodeTypeId] = useState("");
  const [required, setRequired] = useState(false);
  const [scopes, setScopes] = useState(false);

  const { data: nodeTypes } =
    trpc.views.knowledge.ontology.getNodeTypes.useQuery();
  const utils = trpc.useUtils();
  const { mutateAsync: createEdgeType, isLoading } =
    trpc.views.knowledge.ontology.createEdgeType.useMutation();

  const handleSubmit = async () => {
    await createEdgeType({
      outboundName,
      inboundName,
      description,
      sourceNodeTypeId,
      targetNodeTypeId,
      required,
      scopes,
    });
    utils.views.knowledge.ontology.getOntologySummary.invalidate();
    setOutboundName("");
    setInboundName("");
    setDescription("");
    setSourceNodeTypeId("");
    setTargetNodeTypeId("");
    setRequired(false);
    setScopes(false);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Relationship">
      <div className="flex flex-col gap-3 p-5">
        <div>
          <label className="mb-1 block text-[12px] font-medium text-gray-600">
            Name (A → B)
          </label>
          <input
            type="text"
            value={outboundName}
            onChange={(e) => setOutboundName(e.target.value)}
            placeholder="e.g. has_company, participated_in"
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-gray-600">
            Name (B → A)
          </label>
          <input
            type="text"
            value={inboundName}
            onChange={(e) => setInboundName(e.target.value)}
            placeholder="e.g. company_of, has_participant"
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-gray-600">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
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
          <label className="mb-1 block text-[12px] font-medium text-gray-600">
            To
          </label>
          <Select
            value={targetNodeTypeId}
            onChange={setTargetNodeTypeId}
            placeholder="Select type..."
            options={(nodeTypes ?? []).map((nt) => ({
              label: nt.name,
              value: nt.id,
            }))}
          />
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
            !outboundName.trim() ||
            !inboundName.trim() ||
            !sourceNodeTypeId ||
            !targetNodeTypeId ||
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
