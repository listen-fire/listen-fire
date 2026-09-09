// Convert the KG ontology summary into the unified `PartialDescriptor`
// shape every other adapter publishes via `Adapter.describe()`. This is
// the seam that makes the KG "just another adapter" from the editor's
// perspective: ExpressionEditor, the traversal text editor's
// walker / parser / serializer, and the cursor-based autocomplete all
// read the descriptor without caring whether the source is KG-side or
// external.
//
// KG-specific behaviour surfaced through the descriptor:
//   - Property `cardinality: 'multi'` → field `cardinality: 'many'`
//     (drives the multi-value type warning).
//   - Edge types produce TWO references per edge — outgoing on the
//     source type (named by `outbound_name`), incoming on the target
//     type (named by `inbound_name`). The editor's edge picker lists
//     both; the engine dispatches by direction at runtime.

import type { PartialDescriptor, SchemaTypeDescriptor } from "./use-types";

export type OntologyEdgeTypeSummary = {
  id: string;
  outbound_name: string;
  inbound_name: string;
  description?: string;
  source_node_type_id: string;
  target_node_type_id: string;
};

export type OntologyPropertyTypeSummary = {
  id: string;
  name: string;
  description?: string;
  node_type_id: string | null;
  edge_type_id: string | null;
  value_type: string;
  enum_values: string[] | null;
  cardinality?: "single" | "multi";
};

export type OntologyNodeTypeSummary = {
  id: string;
  name: string;
  description?: string;
  category: string;
};

export type OntologySummary = {
  nodeTypes: OntologyNodeTypeSummary[];
  edgeTypes: OntologyEdgeTypeSummary[];
  propertyTypes: OntologyPropertyTypeSummary[];
};

export function ontologyToDescriptor(
  ontology: OntologySummary | undefined,
): PartialDescriptor | undefined {
  if (!ontology) return undefined;

  // Node-typed properties → node descriptor fields.
  const fieldsByNodeType = new Map<string, SchemaTypeDescriptor["fields"]>();
  // Edge-typed properties → reference `edgeFields` (per-edge). Same
  // edge_type_id appears under both the outgoing reference (on source
  // type) and the incoming reference (on target type), so we collect
  // once per edge then attach during reference construction below.
  const edgeFieldsByEdgeId = new Map<string, SchemaTypeDescriptor["fields"]>();
  for (const pt of ontology.propertyTypes) {
    const field: SchemaTypeDescriptor["fields"][number] = {
      fieldId: pt.id,
      displayName: pt.name,
      kind: pt.value_type,
      enumValues: pt.enum_values ?? undefined,
      writable: true,
      required: false,
      cardinality: pt.cardinality === "multi" ? "many" : "one",
      ...(pt.description ? { description: pt.description } : {}),
    };
    if (pt.node_type_id !== null) {
      const arr = fieldsByNodeType.get(pt.node_type_id) ?? [];
      arr.push(field);
      fieldsByNodeType.set(pt.node_type_id, arr);
    } else if (pt.edge_type_id !== null) {
      const arr = edgeFieldsByEdgeId.get(pt.edge_type_id) ?? [];
      arr.push(field);
      edgeFieldsByEdgeId.set(pt.edge_type_id, arr);
    }
  }

  const refsByNodeType = new Map<string, SchemaTypeDescriptor["references"]>();
  const pushRef = (
    nodeTypeId: string,
    ref: SchemaTypeDescriptor["references"][number],
  ) => {
    const arr = refsByNodeType.get(nodeTypeId) ?? [];
    arr.push(ref);
    refsByNodeType.set(nodeTypeId, arr);
  };
  for (const et of ontology.edgeTypes) {
    const edgeFields = edgeFieldsByEdgeId.get(et.id);
    pushRef(et.source_node_type_id, {
      fieldId: et.id,
      targetTypeId: et.target_node_type_id,
      cardinality: "many",
      direction: "outgoing",
      name: et.outbound_name,
      edgeFields,
      ...(et.description ? { description: et.description } : {}),
    });
    pushRef(et.target_node_type_id, {
      fieldId: et.id,
      targetTypeId: et.source_node_type_id,
      cardinality: "many",
      direction: "incoming",
      name: et.inbound_name,
      edgeFields,
      ...(et.description ? { description: et.description } : {}),
    });
  }

  return {
    adapterType: "kg",
    types: ontology.nodeTypes.map((nt) => ({
      typeId: nt.id,
      displayName: nt.name,
      fields: fieldsByNodeType.get(nt.id) ?? [],
      references: refsByNodeType.get(nt.id) ?? [],
      ...(nt.description ? { description: nt.description } : {}),
    })),
  };
}
