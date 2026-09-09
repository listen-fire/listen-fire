"use client";

import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { PropertyValueType, EvaluationStrategy } from "#trpc";
import type { EvidenceType } from "#trpc";
import { Select } from "@/components/select";
import type {
  SummaryNodeType,
  SummaryEdgeType,
  SummaryPropertyType,
  EdgeFilter,
} from "./types";

function parseFilters(raw: unknown): EdgeFilter[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter(
      (f): f is EdgeFilter =>
        typeof f === "object" &&
        f !== null &&
        "side" in f &&
        "property" in f &&
        "value" in f,
    );
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parseFilters(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

const selectClass =
  "rounded-md border border-gray-200 px-2 py-1.5 text-[12px] focus:border-gray-400 focus:outline-none";

// -- Edge Group Body --

function EdgeGroupBody({
  edgeGroup,
  allMembers,
  allNodeTypes,
  onClose,
  onNavigateToNode,
}: {
  edgeGroup: string;
  allMembers: SummaryEdgeType[];
  allNodeTypes: SummaryNodeType[];
  onClose: () => void;
  onNavigateToNode: (nodeId: string) => void;
}) {
  const first = allMembers[0];
  const sourceNodeType = allNodeTypes.find(
    (nt) => nt.id === first.source_node_type_id,
  );
  const utils = trpc.useUtils();

  const [name, setName] = useState(edgeGroup);
  const [description, setDescription] = useState(first.description);
  const [required, setRequired] = useState(first.required);
  const [scopes, setScopes] = useState(first.scopes);
  const [targetIds, setTargetIds] = useState<string[]>(
    allMembers.map((m) => m.target_node_type_id),
  );

  useEffect(() => {
    setName(edgeGroup);
    setDescription(first.description);
    setRequired(first.required);
    setScopes(first.scopes);
    setTargetIds(allMembers.map((m) => m.target_node_type_id));
  }, [edgeGroup, first.id]);

  const { mutateAsync: updateGroup, isLoading: isSaving } =
    trpc.views.knowledge.ontology.updateEdgeGroup.useMutation();
  const { mutateAsync: deleteGroup, isLoading: isDeleting } =
    trpc.views.knowledge.ontology.deleteEdgeGroup.useMutation();

  const originalTargetIds = allMembers
    .map((m) => m.target_node_type_id)
    .sort()
    .join(",");
  const isDirty =
    name !== edgeGroup ||
    description !== first.description ||
    required !== first.required ||
    scopes !== first.scopes ||
    [...targetIds].sort().join(",") !== originalTargetIds;

  const handleSave = async () => {
    await updateGroup({
      edgeGroup,
      name: name !== edgeGroup ? name : undefined,
      description,
      required,
      scopes,
      targetNodeTypeIds: targetIds,
    });
    utils.views.knowledge.ontology.getOntologySummary.invalidate();
  };

  const handleDelete = async () => {
    await deleteGroup({ edgeGroup });
    utils.views.knowledge.ontology.getOntologySummary.invalidate();
    onClose();
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Relationship */}
      <div>
        <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
          Relationship
        </span>
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
          <button
            onClick={() =>
              sourceNodeType && onNavigateToNode(sourceNodeType.id)
            }
            className="font-medium text-primary-600 hover:underline"
          >
            {sourceNodeType?.name ?? "?"}
          </button>
          <span className="text-gray-300">&rarr;</span>
          {allMembers.map((m) => {
            const tnt = allNodeTypes.find(
              (nt) => nt.id === m.target_node_type_id,
            );
            return (
              <button
                key={m.id}
                onClick={() => tnt && onNavigateToNode(tnt.id)}
                className="font-medium text-primary-600 hover:underline"
              >
                {tnt?.name ?? "?"}
              </button>
            );
          })}
        </div>
      </div>

      <hr className="border-gray-100" />

      {/* Name */}
      <div>
        <label className="mb-1 block text-[11px] font-semibold text-gray-600">
          Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={`w-full ${selectClass}`}
        />
      </div>

      {/* Description */}
      <div>
        <label className="mb-1 block text-[11px] font-semibold text-gray-600">
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className={`w-full ${selectClass}`}
        />
      </div>

      {/* Targets */}
      <div>
        <label className="mb-1.5 block text-[11px] font-semibold text-gray-600">
          Targets
        </label>
        <div className="flex flex-col gap-1">
          {allNodeTypes.map((nt) => (
            <label
              key={nt.id}
              className="flex items-center gap-2 text-[12px] text-gray-700"
            >
              <input
                type="checkbox"
                checked={targetIds.includes(nt.id)}
                onChange={() =>
                  setTargetIds((prev) =>
                    prev.includes(nt.id)
                      ? prev.filter((x) => x !== nt.id)
                      : [...prev, nt.id],
                  )
                }
                className="rounded border-gray-300"
              />
              {nt.name}
            </label>
          ))}
        </div>
      </div>

      {/* Toggles */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-semibold text-gray-600">Required</p>
          <p className="text-[10px] text-gray-400">
            Must be present in extraction
          </p>
        </div>
        <button
          onClick={() => setRequired(!required)}
          className={`relative h-5 w-9 rounded-full transition-colors ${required ? "bg-gray-900" : "bg-gray-200"}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${required ? "translate-x-4" : "translate-x-0.5"}`}
          />
        </button>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-semibold text-gray-600">Scopes</p>
          <p className="text-[10px] text-gray-400">Target scopes the source</p>
        </div>
        <button
          onClick={() => setScopes(!scopes)}
          className={`relative h-5 w-9 rounded-full transition-colors ${scopes ? "bg-gray-900" : "bg-gray-200"}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${scopes ? "translate-x-4" : "translate-x-0.5"}`}
          />
        </button>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={!isDirty || targetIds.length === 0 || isSaving}
          className="flex-1 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-white hover:bg-primary-600 disabled:opacity-40"
        >
          {isSaving ? "..." : "Save"}
        </button>
        <button
          onClick={handleDelete}
          disabled={isDeleting}
          className="rounded-md px-3 py-1.5 text-[12px] text-red-600 hover:bg-red-50"
        >
          {isDeleting ? "..." : "Delete"}
        </button>
      </div>

      <hr className="border-gray-100" />
      <p className="text-[10px] text-gray-400">
        Group: {edgeGroup} ({allMembers.length} edge
        {allMembers.length !== 1 ? "s" : ""})
      </p>
    </div>
  );
}

// -- Single Edge Body --

function SingleEdgeBody({
  edgeType,
  allNodeTypes,
  allPropertyTypes,
  onClose,
  onNavigateToNode,
}: {
  edgeType: SummaryEdgeType;
  allNodeTypes: SummaryNodeType[];
  allPropertyTypes: SummaryPropertyType[];
  onClose: () => void;
  onNavigateToNode: (nodeId: string) => void;
}) {
  const utils = trpc.useUtils();
  const [outboundName, setOutboundName] = useState(edgeType.outbound_name);
  const [inboundName, setInboundName] = useState(edgeType.inbound_name);
  const [description, setDescription] = useState(edgeType.description);
  const [required, setRequired] = useState(edgeType.required);
  const [scopes, setScopes] = useState(edgeType.scopes);
  const [filters, setFilters] = useState<EdgeFilter[]>(
    parseFilters(edgeType.filters),
  );
  const [showAddProperty, setShowAddProperty] = useState(false);

  const { mutateAsync: createPropertyType, isLoading: isCreatingProp } =
    trpc.views.knowledge.ontology.createPropertyType.useMutation();
  const { mutateAsync: updatePropertyType, isLoading: isUpdatingProp } =
    trpc.views.knowledge.ontology.updatePropertyType.useMutation();
  const { mutateAsync: deletePropertyType } =
    trpc.views.knowledge.ontology.deletePropertyType.useMutation();
  const [editingPropertyId, setEditingPropertyId] = useState<string | null>(
    null,
  );

  const edgeProperties = useMemo(
    () => allPropertyTypes.filter((pt) => pt.edge_type_id === edgeType.id),
    [allPropertyTypes, edgeType.id],
  );

  useEffect(() => {
    setOutboundName(edgeType.outbound_name);
    setInboundName(edgeType.inbound_name);
    setDescription(edgeType.description);
    setRequired(edgeType.required);
    setScopes(edgeType.scopes);
    setFilters(parseFilters(edgeType.filters));
    setEditingPropertyId(null);
  }, [edgeType.id]);

  const { mutateAsync: updateEdge, isLoading: isSaving } =
    trpc.views.knowledge.ontology.updateEdgeType.useMutation();
  const { mutateAsync: deleteEdge, isLoading: isDeleting } =
    trpc.views.knowledge.ontology.deleteEdgeType.useMutation();

  const isDirty =
    outboundName !== edgeType.outbound_name ||
    inboundName !== edgeType.inbound_name ||
    description !== edgeType.description ||
    required !== edgeType.required ||
    scopes !== edgeType.scopes ||
    JSON.stringify(filters) !== JSON.stringify(parseFilters(edgeType.filters));

  const sourceNodeType = allNodeTypes.find(
    (nt) => nt.id === edgeType.source_node_type_id,
  );
  const targetNodeType = allNodeTypes.find(
    (nt) => nt.id === edgeType.target_node_type_id,
  );

  const propertiesForSide = (
    side: "source" | "target",
  ): SummaryPropertyType[] => {
    const nodeTypeId =
      side === "source"
        ? edgeType.source_node_type_id
        : edgeType.target_node_type_id;
    return allPropertyTypes.filter((pt) => pt.node_type_id === nodeTypeId);
  };

  const handleSave = async () => {
    await updateEdge({
      id: edgeType.id,
      outboundName,
      inboundName,
      description,
      required,
      scopes,
      filters,
    });
    utils.views.knowledge.ontology.getOntologySummary.invalidate();
  };

  const handleDelete = async () => {
    await deleteEdge({ id: edgeType.id });
    utils.views.knowledge.ontology.getOntologySummary.invalidate();
    onClose();
  };

  const handleCreateEdgeProperty = async (data: EdgePropertyFormData) => {
    await createPropertyType({
      edgeTypeId: edgeType.id,
      name: data.name,
      description: data.description,
      valueType: data.valueType as PropertyValueType,
      evaluationStrategy: data.evaluationStrategy as EvaluationStrategy,
      writableBy: data.writableBy as EvidenceType[] | null,
    });
    utils.views.knowledge.ontology.getOntologySummary.invalidate();
    setShowAddProperty(false);
  };

  const handleUpdateEdgeProperty = async (id: string, data: EdgePropertyFormData) => {
    await updatePropertyType({
      id,
      name: data.name,
      description: data.description,
      valueType: data.valueType as PropertyValueType,
      evaluationStrategy: data.evaluationStrategy as EvaluationStrategy,
      writableBy: data.writableBy as EvidenceType[] | null,
    });
    utils.views.knowledge.ontology.getOntologySummary.invalidate();
    setEditingPropertyId(null);
  };

  const handleDeleteEdgeProperty = async (id: string) => {
    await deletePropertyType({ id });
    utils.views.knowledge.ontology.getOntologySummary.invalidate();
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Relationship */}
      <div>
        <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
          Relationship
        </span>
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
          <button
            onClick={() =>
              sourceNodeType && onNavigateToNode(sourceNodeType.id)
            }
            className="font-medium text-primary-600 hover:underline"
          >
            {sourceNodeType?.name ?? "?"}
          </button>
          <span className="text-gray-300">&rarr;</span>
          <button
            onClick={() =>
              targetNodeType && onNavigateToNode(targetNodeType.id)
            }
            className="font-medium text-primary-600 hover:underline"
          >
            {targetNodeType?.name ?? "?"}
          </button>
        </div>
      </div>

      <hr className="border-gray-100" />

      {/* Names */}
      <div>
        <label className="mb-1 block text-[11px] font-semibold text-gray-600">
          Outbound Name
        </label>
        <input
          type="text"
          value={outboundName}
          onChange={(e) => setOutboundName(e.target.value)}
          className={`w-full ${selectClass}`}
        />
      </div>
      <div>
        <label className="mb-1 block text-[11px] font-semibold text-gray-600">
          Inbound Name
        </label>
        <input
          type="text"
          value={inboundName}
          onChange={(e) => setInboundName(e.target.value)}
          className={`w-full ${selectClass}`}
        />
      </div>

      {/* Description */}
      <div>
        <label className="mb-1 block text-[11px] font-semibold text-gray-600">
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className={`w-full ${selectClass}`}
        />
      </div>

      {/* Toggles */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-semibold text-gray-600">Required</p>
          <p className="text-[10px] text-gray-400">
            Must be present in extraction
          </p>
        </div>
        <button
          onClick={() => setRequired(!required)}
          className={`relative h-5 w-9 rounded-full transition-colors ${required ? "bg-gray-900" : "bg-gray-200"}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${required ? "translate-x-4" : "translate-x-0.5"}`}
          />
        </button>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-semibold text-gray-600">Scopes</p>
          <p className="text-[10px] text-gray-400">Target scopes the source</p>
        </div>
        <button
          onClick={() => setScopes(!scopes)}
          className={`relative h-5 w-9 rounded-full transition-colors ${scopes ? "bg-gray-900" : "bg-gray-200"}`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${scopes ? "translate-x-4" : "translate-x-0.5"}`}
          />
        </button>
      </div>

      {/* Filters */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
            Filters
          </span>
          <button
            onClick={() =>
              setFilters([
                ...filters,
                { side: "source", property: "", value: "" },
              ])
            }
            className="text-[11px] text-gray-500 hover:text-gray-700"
          >
            + Add
          </button>
        </div>
        {filters.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {filters.map((f, i) => {
              const sideProps = propertiesForSide(f.side);
              const selectedProp = sideProps.find((p) => p.name === f.property);
              const enumVals = selectedProp?.enum_values;

              return (
                <div key={i} className="flex items-center gap-1.5">
                  <Select
                    value={f.side}
                    onChange={(v) => {
                      const newF = [...filters];
                      newF[i] = {
                        side: v as "source" | "target",
                        property: "",
                        value: "",
                      };
                      setFilters(newF);
                    }}
                    className="w-20"
                    size="sm"
                    options={[
                      { label: "source", value: "source" },
                      { label: "target", value: "target" },
                    ]}
                  />
                  <Select
                    value={f.property}
                    onChange={(v) => {
                      const newF = [...filters];
                      newF[i] = { ...f, property: v, value: "" };
                      setFilters(newF);
                    }}
                    className="flex-1"
                    size="sm"
                    placeholder="property"
                    options={sideProps.map((p) => ({
                      label: p.name,
                      value: p.name,
                    }))}
                  />
                  {enumVals && enumVals.length > 0 ? (
                    <Select
                      value={f.value}
                      onChange={(v) => {
                        const newF = [...filters];
                        newF[i] = { ...f, value: v };
                        setFilters(newF);
                      }}
                      className="flex-1"
                      size="sm"
                      placeholder="value"
                      options={enumVals.map((v) => ({ label: v, value: v }))}
                    />
                  ) : (
                    <input
                      type="text"
                      placeholder="value"
                      value={f.value}
                      onChange={(e) => {
                        const newF = [...filters];
                        newF[i] = { ...f, value: e.target.value };
                        setFilters(newF);
                      }}
                      className={`flex-1 ${selectClass}`}
                    />
                  )}
                  <button
                    onClick={() =>
                      setFilters(filters.filter((_, fi) => fi !== i))
                    }
                    className="text-gray-300 hover:text-red-500"
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-[11px] text-gray-400">No filters configured</p>
        )}
      </div>

      {/* Edge Properties */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400/80">
            Edge Properties ({edgeProperties.length})
          </span>
          {!showAddProperty && (
            <button
              onClick={() => setShowAddProperty(true)}
              className="text-[11px] text-gray-500 hover:text-gray-700"
            >
              + Add
            </button>
          )}
        </div>
        <div className="space-y-1.5">
          {edgeProperties.map((pt) => (
            <EdgePropertyCard
              key={pt.id}
              property={pt}
              isEditing={editingPropertyId === pt.id}
              onEdit={() => setEditingPropertyId(pt.id)}
              onSave={(data) => handleUpdateEdgeProperty(pt.id, data)}
              onCancel={() => setEditingPropertyId(null)}
              onDelete={() => handleDeleteEdgeProperty(pt.id)}
              isLoading={isUpdatingProp}
            />
          ))}
          {!showAddProperty && edgeProperties.length === 0 && (
            <p className="text-[11px] text-gray-400">No edge properties</p>
          )}
          {showAddProperty && (
            <EdgePropertyCard
              isEditing={true}
              onSave={handleCreateEdgeProperty}
              onCancel={() => setShowAddProperty(false)}
              isLoading={isCreatingProp}
            />
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={!isDirty || isSaving}
          className="flex-1 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-white hover:bg-primary-600 disabled:opacity-40"
        >
          {isSaving ? "..." : "Save"}
        </button>
        <button
          onClick={handleDelete}
          disabled={isDeleting}
          className="rounded-md px-3 py-1.5 text-[12px] text-red-600 hover:bg-red-50"
        >
          {isDeleting ? "..." : "Delete"}
        </button>
      </div>

      <hr className="border-gray-100" />
      <p className="text-[10px] text-gray-400">ID: {edgeType.id}</p>
    </div>
  );
}

// -- Edge Property Card (unified view/edit) --

const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  extraction: "Pipeline",
  user_edit: "User",
  retrieval: "Retrieval",
  input_mapping: "Input Mapping",
};

const ALL_EVIDENCE_TYPES = ["extraction", "user_edit", "retrieval", "input_mapping"] as const;

type EdgePropertyFormData = {
  name: string;
  description: string;
  valueType: string;
  evaluationStrategy: string;
  writableBy: string[] | null;
};

function EdgePropertyCard({
  property,
  isEditing,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  isLoading,
}: {
  property?: SummaryPropertyType;
  isEditing: boolean;
  onEdit?: () => void;
  onSave: (data: EdgePropertyFormData) => void;
  onCancel: () => void;
  onDelete?: () => void;
  isLoading: boolean;
}) {
  const [name, setName] = useState(property?.name ?? "");
  const [description, setDescription] = useState(property?.description ?? "");
  const [valueType, setValueType] = useState(property?.value_type ?? "text");
  const [evaluationStrategy, setEvaluationStrategy] = useState(
    property?.evaluation_strategy ?? "latest",
  );
  const [writableBy, setWritableBy] = useState<string[] | null>(
    property?.writable_by ?? null,
  );

  useEffect(() => {
    if (isEditing) {
      setName(property?.name ?? "");
      setDescription(property?.description ?? "");
      setValueType(property?.value_type ?? "text");
      setEvaluationStrategy(property?.evaluation_strategy ?? "latest");
      setWritableBy(property?.writable_by ?? null);
    }
  }, [isEditing]);

  const fieldLabel = "text-[11px] font-medium text-gray-500";
  const inputClass =
    "w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] focus:border-gray-400 focus:outline-none";

  // --- View mode ---
  if (!isEditing && property) {
    return (
      <div
        className="group cursor-pointer rounded-lg border border-gray-100 px-3 py-2.5 transition-colors hover:border-gray-200 hover:bg-gray-50/50"
        onClick={onEdit}
      >
        <div className="mb-1 flex items-start justify-between gap-2">
          <p className="text-[13px] font-medium text-gray-800">
            {property.name}
          </p>
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="shrink-0 rounded p-0.5 text-gray-300 opacity-0 transition-all group-hover:opacity-100 hover:text-red-500"
            >
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
        {property.description && (
          <p className="mb-2 text-[11px] leading-snug text-gray-400">
            {property.description}
          </p>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px]">
          <span>
            <span className="text-gray-400">Type</span>{" "}
            <span className="text-gray-600">{property.value_type}</span>
          </span>
          <span>
            <span className="text-gray-400">Strategy</span>{" "}
            <span className="text-gray-600">
              {property.evaluation_strategy}
            </span>
          </span>
          {property.writable_by && (
            <span>
              <span className="text-gray-400">Writable by</span>{" "}
              <span className="text-gray-600">
                {property.writable_by.map((t) => EVIDENCE_TYPE_LABELS[t] ?? t).join(", ")}
              </span>
            </span>
          )}
        </div>
      </div>
    );
  }

  // --- Edit mode ---
  return (
    <div className="rounded-lg border border-primary/20 bg-gray-50/50 px-3 py-3">
      <div className="space-y-3">
        <div>
          <label className={`mb-1 block ${fieldLabel}`}>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            autoFocus
          />
        </div>
        <div>
          <label className={`mb-1 block ${fieldLabel}`}>Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
            className={inputClass}
          />
        </div>

        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
          <label className={fieldLabel}>Type</label>
          <Select
            value={valueType}
            onChange={setValueType}
            size="sm"
            options={[
              { label: "text", value: "text" },
              { label: "number", value: "number" },
              { label: "date", value: "date" },
              { label: "boolean", value: "boolean" },
              { label: "json", value: "json" },
            ]}
          />
        </div>

        <div>
          <div className="mb-1 flex items-center gap-2">
            <label className={fieldLabel}>Writable By</label>
            <label className="flex items-center gap-1 text-[10px] text-gray-400">
              <input
                type="checkbox"
                checked={writableBy === null}
                onChange={(e) => setWritableBy(e.target.checked ? null : [...ALL_EVIDENCE_TYPES])}
                className="h-3 w-3 rounded border-gray-300"
              />
              all
            </label>
          </div>
          {writableBy !== null && (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {ALL_EVIDENCE_TYPES.map((et) => (
                <label key={et} className="flex items-center gap-1 text-[11px] text-gray-600">
                  <input
                    type="checkbox"
                    checked={writableBy.includes(et)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setWritableBy([...writableBy, et]);
                      } else {
                        setWritableBy(writableBy.filter((t) => t !== et));
                      }
                    }}
                    className="h-3 w-3 rounded border-gray-300"
                  />
                  {EVIDENCE_TYPE_LABELS[et] ?? et}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          onClick={() =>
            onSave({
              name,
              description,
              valueType,
              evaluationStrategy,
              writableBy,
            })
          }
          disabled={!name.trim() || isLoading}
          className="flex-1 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-40"
        >
          {isLoading ? "..." : property ? "Save" : "Add"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-[12px] text-gray-500 transition-colors hover:bg-gray-100"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// -- Edge Detail Panel --

export function EdgeDetailPanel({
  edgeTypeId,
  allNodeTypes,
  allEdgeTypes,
  allPropertyTypes,
  onClose,
  onNavigateToNode,
}: {
  edgeTypeId: string;
  allNodeTypes: SummaryNodeType[];
  allEdgeTypes: SummaryEdgeType[];
  allPropertyTypes: SummaryPropertyType[];
  onClose: () => void;
  onNavigateToNode: (nodeId: string) => void;
}) {
  const edgeType = allEdgeTypes.find((et) => et.id === edgeTypeId);
  if (!edgeType) return null;

  const groupMembers = edgeType.edge_group
    ? allEdgeTypes.filter((et) => et.edge_group === edgeType.edge_group)
    : [];
  const isGrouped = groupMembers.length > 1;

  return (
    <div className="p-4">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="text-[15px] font-semibold text-gray-900">
            {isGrouped
              ? edgeType.edge_group?.replace(/_/g, " ")
              : edgeType.outbound_name.replace(/_/g, " ")}
          </h2>
          <span className="mt-1 inline-block rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">
            {isGrouped ? "edge group" : "edge type"}
          </span>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {isGrouped && edgeType.edge_group ? (
        <EdgeGroupBody
          edgeGroup={edgeType.edge_group}
          allMembers={groupMembers}
          allNodeTypes={allNodeTypes}
          onClose={onClose}
          onNavigateToNode={onNavigateToNode}
        />
      ) : (
        <SingleEdgeBody
          edgeType={edgeType}
          allNodeTypes={allNodeTypes}
          allPropertyTypes={allPropertyTypes}
          onClose={onClose}
          onNavigateToNode={onNavigateToNode}
        />
      )}
    </div>
  );
}
