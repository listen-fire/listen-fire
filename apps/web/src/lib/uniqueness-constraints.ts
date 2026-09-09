// Shared parser + serializer for the constraint-text format used by the
// ontology editor (`components/ontology/node-detail-panel.tsx`).
//
// Format mirrors the canonical `node_type.uniqueness_constraints` JSONB shape
// from the API: an OR-array of AND-arrays of `ConstraintEntry`. Each entry is
// either:
//   • a property (bare name), optionally wrapped in `FUZZY(...)`
//   • an outgoing edge (`-[:NodeTypeName]->`)
//   • a compound-scope binding (`edge_to:AncestorName`) — references a
//     TG-ancestor action's binding name; used by R5's compound scoping
//     (see `plans/2026-05-19-tg-extraction-parity/compound_scoping.md`).
// Multiple AND-terms join with `AND`.
//
// Example: `FUZZY(Name) AND edge_to:round` parses to a constraint that
// requires a fuzzy-matching name AND an edge to the ancestor bound under
// the name `round`.

export type ExpressionConstraintEntry = {
  expr: {
    type: string;
    propertyTypeId?: string;
    steps?: Array<{ type: string; edgeTypeId?: string; direction?: string }>;
    [key: string]: unknown;
  };
  fuzzy?: boolean;
};

export type EdgeToConstraintEntry = {
  kind: "edge_to";
  ancestorName: string;
};

export type ConstraintEntry = ExpressionConstraintEntry | EdgeToConstraintEntry;

export function isEdgeToEntry(
  entry: ConstraintEntry,
): entry is EdgeToConstraintEntry {
  return (
    typeof (entry as EdgeToConstraintEntry).kind === "string" &&
    (entry as EdgeToConstraintEntry).kind === "edge_to"
  );
}

export type EdgeLookup = {
  id: string;
  direction: "outgoing" | "incoming";
  otherNodeTypeName: string;
};

export type ParseResult =
  | { ok: true; entries: ConstraintEntry[] }
  | { ok: false; error: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fallback label for an id the name map doesn't cover. KG ids are UUIDs —
// showing the whole thing is noise, so we shorten to the leading 8 chars
// as a hint. Adapter ids are human-readable slugs (e.g. `email_addresses`)
// — slicing those would mangle them ("email_ad"), so they render whole.
function fallbackLabel(id: string): string {
  return UUID_RE.test(id) ? id.slice(0, 8) : id;
}

export function serializeConstraint(
  entries: ConstraintEntry[],
  propertyMap: Map<string, string>,
  edgeMap: Map<string, { otherNodeTypeName: string }>,
): string {
  return entries
    .map((entry) => {
      if (isEdgeToEntry(entry)) {
        return `edge_to:${entry.ancestorName}`;
      }
      let token: string;
      const expr = entry.expr;
      if (expr.type === "property" && expr.propertyTypeId) {
        token = propertyMap.get(expr.propertyTypeId) ?? fallbackLabel(expr.propertyTypeId);
      } else if (expr.type === "traverse" && expr.steps?.[0]?.edgeTypeId) {
        const edge = edgeMap.get(expr.steps[0].edgeTypeId!);
        token = `-[:${edge?.otherNodeTypeName ?? fallbackLabel(expr.steps[0].edgeTypeId!)}]->`;
      } else {
        token = expr.type;
      }
      return entry.fuzzy ? `FUZZY(${token})` : token;
    })
    .join(" AND ");
}

export function parseConstraintText(
  text: string,
  propertyByName: Map<string, string>,
  edgeByNodeTypeName: Map<string, EdgeLookup>,
  options?: {
    /**
     * TG-ancestor binding names in scope for this node. When provided,
     * `edge_to:<name>` entries must reference a member; otherwise the
     * parser returns an inline error. Omit (e.g. for the ontology
     * editor, which has no TG scope) to accept any non-empty name.
     */
    ancestorNamesInScope?: ReadonlySet<string>;
  },
): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Empty expression" };

  const parts = trimmed.split(/\s+AND\s+/i);
  const entries: ConstraintEntry[] = [];

  for (const raw of parts) {
    let part = raw.trim();
    if (!part) return { ok: false, error: "Empty term in expression" };

    // Compound-scope: `edge_to:AncestorName`. Must appear before the
    // FUZZY/property branches because the term starts with a keyword,
    // and is direction-agnostic by design (no FUZZY wrapping allowed).
    const edgeToMatch = part.match(/^edge_to:\s*(.+)$/i);
    if (edgeToMatch) {
      const ancestorName = edgeToMatch[1].trim();
      if (!ancestorName) {
        return { ok: false, error: "edge_to entry missing ancestor name" };
      }
      if (
        options?.ancestorNamesInScope &&
        !options.ancestorNamesInScope.has(ancestorName)
      ) {
        return {
          ok: false,
          error: `Unknown ancestor "${ancestorName}" — no ancestor action binds this name`,
        };
      }
      entries.push({ kind: "edge_to", ancestorName });
      continue;
    }

    let fuzzy = false;
    const fuzzyMatch = part.match(/^FUZZY\((.+)\)$/i);
    if (fuzzyMatch) {
      fuzzy = true;
      part = fuzzyMatch[1].trim();
    }

    const edgeMatch = part.match(/^-\[:(.+?)\]->$/);
    if (edgeMatch) {
      const name = edgeMatch[1].trim();
      const edge = edgeByNodeTypeName.get(name.toLowerCase());
      if (!edge) return { ok: false, error: `Unknown edge target "${name}"` };
      entries.push({
        expr: {
          type: "traverse",
          steps: [{ type: "edge", edgeTypeId: edge.id, direction: edge.direction }],
          expression: { type: "static", value: true },
        },
        ...(fuzzy ? { fuzzy: true } : {}),
      });
      continue;
    }

    const propId = propertyByName.get(part.toLowerCase());
    if (propId) {
      entries.push({
        expr: { type: "property", propertyTypeId: propId },
        ...(fuzzy ? { fuzzy: true } : {}),
      });
      continue;
    }

    return { ok: false, error: `Unknown property or edge "${part}"` };
  }

  return { ok: true, entries };
}

// ── Flat (TG/target) currency ────────────────────────────────────────────
// The TG action-node editor speaks the flat, opaque `UniquenessConstraints`
// shape (3b §3.2): AND-groups of `{ field, fuzzy? }`, where `field` is a
// `describe()` fieldId — a property, a KG edge_type_id, or an external
// adapter's reference fieldId. Same text grammar as above, different
// storage currency.

export type FlatEntry = { field: string; fuzzy?: boolean };

export type FlatParseResult =
  | { ok: true; entries: FlatEntry[] }
  | { ok: false; error: string };

export function serializeGroup(
  entries: readonly FlatEntry[],
  propertyMap: Map<string, string>,
  edgeMap: Map<string, { otherNodeTypeName: string }>,
): string {
  return entries
    .map((entry) => {
      const edge = edgeMap.get(entry.field);
      if (edge) return `-[:${edge.otherNodeTypeName}]->`;
      const label = propertyMap.get(entry.field) ?? fallbackLabel(entry.field);
      return entry.fuzzy ? `FUZZY(${label})` : label;
    })
    .join(" AND ");
}

export function parseGroup(
  text: string,
  propertyByName: Map<string, string>,
  edgeByNodeTypeName: Map<string, EdgeLookup>,
): FlatParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Empty expression" };

  const parts = trimmed.split(/\s+AND\s+/i);
  const entries: FlatEntry[] = [];

  for (const raw of parts) {
    let part = raw.trim();
    if (!part) return { ok: false, error: "Empty term in expression" };

    let fuzzy = false;
    const fuzzyMatch = part.match(/^FUZZY\((.+)\)$/i);
    if (fuzzyMatch) {
      fuzzy = true;
      part = fuzzyMatch[1].trim();
    }

    const edgeMatch = part.match(/^-\[:(.+?)\]->$/);
    if (edgeMatch) {
      const name = edgeMatch[1].trim();
      const edge = edgeByNodeTypeName.get(name.toLowerCase());
      if (!edge) return { ok: false, error: `Unknown connection "${name}"` };
      // A connection is identity-by-adjacency; fuzzy doesn't apply to it.
      entries.push({ field: edge.id });
      continue;
    }

    const fieldId = propertyByName.get(part.toLowerCase());
    if (fieldId) {
      entries.push({ field: fieldId, ...(fuzzy ? { fuzzy: true } : {}) });
      continue;
    }

    return { ok: false, error: `Unknown field or connection "${part}"` };
  }

  return { ok: true, entries };
}
