// Structural conformance — the ONE comparator.
//
// "Does this position carry everything that structure declares?" is asked in
// three places now, and it is the same question every time: a node literal
// reaching a declared parameter (wave 1), a call's value reaching one (layer
// 10 §A), and an `IS <Doc>` predicate (layer 10 §D). So the rule lives here,
// once, phrased over what a position OFFERS rather than over how it was
// minted — a synthesised landing and an adapter-backed one are compared by the
// same code because a type IS its structure, whoever made it.
//
// It is TypeScript's structural assignability, unchanged: every member the
// required side declares must be present and compatible; extra members are
// fine (the required side cannot see them).

import type { ShapeDeclaration, ShapeNode } from '../parser/ast';
import {
  describeFieldType,
  parseFieldTypeName,
  type PositionSchema,
  surfaceNotEnumerated,
  type FieldType,
  type InstanceSchema,
} from './catalog';
import { fieldAssignable } from './typing';

/**
 * Derives the same schema shape adapters publish for an in-file node declaration.
 *
 * A declaration is a TREE, so a position's identity is its PATH from the root
 * (`doc`, `doc.file`) — two siblings may each declare a `file` child and mean
 * different structures. The root's key is the declaration's own name, which is
 * what `<doc>` resolves to: the declaration IS its root node.
 *
 * Shared with the engine, so a `<Doc>` predicate is compared against the same
 * structure at run time that it was checked against.
 */
export function shapeToSchema(
  decl: ShapeDeclaration,
  /** Resolves an annotation naming an author-declared refinement
   *  (`type Thesis = <"A" | "B">`). Both sides pass it, so the schema stays
   *  the same one on either side of the save. */
  resolveDeclaredType?: (name: string) => FieldType | undefined,
): InstanceSchema {
  const schema: InstanceSchema = { positions: {}, collections: {}, writableRoots: {} };
  const add = (node: ShapeNode, key: string): void => {
    const properties: Record<string, FieldType> = {};
    for (const field of node.fields) {
      // Unknown surface type names degrade to text rather than dropping the
      // field (a dropped field would false-positive every write to it).
      properties[field.name] =
        parseFieldTypeName(field.type) ?? resolveDeclaredType?.(field.type) ?? 'text';
    }
    const edges: PositionSchema['edges'] = {};
    for (const child of node.children) {
      // The nesting IS the edge, and the nested node's name IS the edge name.
      edges[child.name] = { target: `${key}.${child.name}`, writable: true };
    }
    schema.positions[key] = { properties, edges };
    schema.writableRoots[key] = { fields: properties, resultShape: properties };
    schema.collections[key] = { target: key };
    for (const child of node.children) add(child, `${key}.${child.name}`);
  };
  add(decl.root, decl.name);
  return schema;
}

/**
 * What a supplied position OFFERS, as a plane pair — the only view structural
 * comparison needs.
 *
 * Landings are THUNKS so a caller can produce a surface without walking a whole
 * graph up front, and so the two callers (the checker, over its type refs; the
 * engine, over its live bindings) can each answer the arrow plane in their own
 * currency. Recursion is driven by the REQUIRED side, so most thunks are never
 * forced.
 */
export interface SuppliedSurface {
  /** Dot plane. A name present with an `undefined` type is declared-but-untyped. */
  properties: Record<string, FieldType | undefined>;
  /** Arrow plane. A name present with an `undefined` landing is the same fact. */
  edges: Record<string, (() => SuppliedSurface | undefined) | undefined>;
}

/** The surface a published schema offers at `position` — `undefined` when
 *  nothing is enumerated behind it, which is no claim in either direction. */
export function schemaSurface(
  schema: InstanceSchema,
  position: string,
): SuppliedSurface | undefined {
  const declared = schema.positions[position];
  if (!declared || surfaceNotEnumerated(declared)) return undefined;
  return {
    properties: declared.properties,
    edges: Object.fromEntries(
      Object.entries(declared.edges).map(([name, edge]) => [
        name,
        schema.positions[edge.target] !== undefined
          ? () => schemaSurface(schema, edge.target)
          : undefined,
      ]),
    ),
  };
}

/** Where a required structure lives — a schema and the position within it. */
export interface RequiredPosition {
  schema: InstanceSchema;
  position: string;
}

/**
 * Does `supplied` carry everything `required` declares? Recursion is driven by
 * the REQUIRED side, so `seen` guards a required graph that cycles back on
 * itself.
 *
 * Returns the first thing that doesn't fit, phrased for the author, or
 * `undefined` when it fits — and also `undefined` when there is nothing to
 * check against (an unknown supplied entry, an unenumerated required position),
 * because unknown fits anything: the same benefit of the doubt every other
 * unchecked read gets.
 */
export function surfaceMisfit(
  supplied: SuppliedSurface | undefined,
  required: RequiredPosition,
  path = '',
  seen: ReadonlySet<string> = new Set(),
): string | undefined {
  const schema = required.schema.positions[required.position];
  if (!schema || surfaceNotEnumerated(schema)) return undefined;
  if (supplied === undefined) return undefined;
  for (const [name, want] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(supplied.properties, name)) {
      return `it has no ${path}\`${name}\``;
    }
    const have = supplied.properties[name];
    if (have === undefined) continue;
    if (!fieldAssignable(have, want)) {
      return `its ${path}\`${name}\` is ${describeFieldType(have)}, not ${describeFieldType(want)}`;
    }
  }
  for (const [name, edge] of Object.entries(schema.edges)) {
    // Edges are zero-or-more; an absent edge IS the empty set, not a missing
    // member — nothing downstream needs a presence guarantee (traversal off
    // an empty edge already runs zero times). Only a SUPPLIED edge's target
    // is checked for conformance below.
    if (!Object.hasOwn(supplied.edges, name)) continue;
    if (seen.has(edge.target)) continue;
    const landing = supplied.edges[name];
    const misfit = surfaceMisfit(
      landing?.(),
      { schema: required.schema, position: edge.target },
      `${name} → `,
      new Set([...seen, edge.target]),
    );
    if (misfit !== undefined) return misfit;
  }
  return undefined;
}
