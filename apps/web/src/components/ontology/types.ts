import type { ConstraintEntry } from "@/lib/uniqueness-constraints";

export type SummaryNodeType = {
  id: string;
  name: string;
  description: string;
  category: string;
  icon_svg: string | null;
  display_name_template: string | null;
  display_name_expression?: unknown | null;
  uniqueness_constraints?: ConstraintEntry[][] | null | unknown;
};

export type { ConstraintEntry };

export type SummaryEdgeType = {
  id: string;
  outbound_name: string;
  inbound_name: string;
  description: string;
  source_node_type_id: string;
  target_node_type_id: string;
  required: boolean;
  scopes: boolean;
  filters?: unknown;
  edge_group?: string | null;
};

export type SummaryPropertyType = {
  id: string;
  node_type_id: string | null;
  edge_type_id: string | null;
  name: string;
  description: string;
  value_type: string;
  identity: string;
  evaluation_strategy: string;
  enum_values: string[] | null;
  writable_by: string[] | null;
};

export type EdgeFilter = {
  side: 'source' | 'target';
  property: string;
  value: string;
};

export type GraphSelection =
  | { type: 'node'; id: string }
  | { type: 'edge'; id: string }
  | null;
