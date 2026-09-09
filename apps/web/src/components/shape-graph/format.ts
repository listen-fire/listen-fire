// JSX-free formatting helpers for the shape-graph primitive.
//
// Lives in a separate module from `icons.tsx` so the apps/web
// node-env jest runner (no JSX transform) can import the
// helpers from `__test__/`. Matches the same pattern E2 + E3
// followed for their inspector helpers.

import type { ShapePropertyType } from './types';

/**
 * Short label for an ExpressionType — e.g. `list<record>`,
 * `enum(red, blue)`. Used for canvas node sub-labels and
 * inspector type chips.
 */
export function formatPropertyType(t: ShapePropertyType): string {
  switch (t.kind) {
    case 'list':
      return `list<${formatPropertyType(t.element)}>`;
    case 'record':
      return `record(${Object.keys(t.fields).length})`;
    case 'enum':
      return `enum(${t.values.length})`;
    default:
      return t.kind;
  }
}
