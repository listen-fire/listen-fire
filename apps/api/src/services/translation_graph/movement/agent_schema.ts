import type { EdgeSchema, InstanceSchema, WritableRootSchema } from 'movement-lang';

// An `EdgeSchema`'s `readable` / `writable` follow the projection's authoring
// convention: absent ⇒ true; only an explicit opt-out is stored (a write-only
// or read-only edge). That convention is ergonomic for adapter authors but
// leaves an agent reading a described instance to APPLY the default itself —
// and the default isn't even uniform across the schema's slots. So at the
// describe boundary we fill the two booleans explicitly: the agent reads truth,
// never a rule it has to know.
//
// This is a WIRE-level pass, deliberately kept off the shared projection: the
// `InstanceSchema` handed to `describeMovementInstance` is the SAME TTL-cached
// object the compile/checker path consumes, where absent-vs-present is
// load-bearing. So every level this touches is reconstructed — the cached
// input is never mutated.

function withEdgeDefaults(edges: Record<string, EdgeSchema>): Record<string, EdgeSchema> {
  return Object.fromEntries(
    Object.entries(edges).map(([name, edge]) => [
      name,
      { ...edge, readable: edge.readable ?? true, writable: edge.writable ?? true },
    ]),
  );
}

function normaliseRoot(root: WritableRootSchema): WritableRootSchema {
  return root.edges === undefined ? root : { ...root, edges: withEdgeDefaults(root.edges) };
}

function normaliseRoots(
  roots: Record<string, WritableRootSchema>,
): Record<string, WritableRootSchema> {
  return Object.fromEntries(Object.entries(roots).map(([name, root]) => [name, normaliseRoot(root)]));
}

/**
 * Return an agent-facing copy of a described instance's schema with every
 * edge's `readable`/`writable` resolved to its concrete value. Entry-point
 * writability already ships explicitly on the walked node, and a field's
 * read/write is encoded structurally (`properties` vs `writableRoots.fields`
 * vs `writeOnlyProperties`); edges are the one slot where the default is left
 * implicit, so they are all this pass fills.
 */
export function normaliseSchemaForAgent(schema: InstanceSchema): InstanceSchema {
  return {
    ...schema,
    positions: Object.fromEntries(
      Object.entries(schema.positions).map(([name, position]) => [
        name,
        { ...position, edges: withEdgeDefaults(position.edges) },
      ]),
    ),
    writableRoots: normaliseRoots(schema.writableRoots),
    ...(schema.createShapes === undefined ? {} : { createShapes: normaliseRoots(schema.createShapes) }),
  };
}
