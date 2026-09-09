// Shared, low-dependency ORDER BY / LIMIT evaluation — the first slice of the
// reusable filter unit (plan: 2026-06-15-adapter-capability-contract). Pure
// sorting/slicing over a yielded set; the only impurity (reading an item's
// order key) is INJECTED via `options.value`, so this stays free of engine, KG,
// adapter, and AI dependencies. The engine uses it for in-engine values; local
// adapters can import it to self-service ordering/limiting over a bounded set.

import { isPurePredicate } from './filter';
import type { EdgeStep, Expression } from './types';

/** Total order for ORDER BY keys: numbers numerically, else lexicographically;
 *  empty (null/undefined) sorts last regardless of direction. */
export function compareOrderValues(a: unknown, b: unknown): number {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** The hop cardinality shape the bracket grammar produces. */
export type HopCardinality = EdgeStep['cardinality'];

/** The ORDER BY key a hop carries, when it carries one — an expression over the
 *  element, evaluated once per element before the sort. */
export function hopOrderKey(cardinality: HopCardinality): Expression | undefined {
  return cardinality?.orderBy;
}

/**
 * The bare property of the LANDED RECORD an ordering key names, when it names
 * one. That is the only key shape an adapter can be asked to sort by: anything
 * else (a path through the element's own alias, a computed key) is a walk of
 * this engine's, not a column of the source's.
 *
 */
export function orderKeyProperty(key: Expression | undefined): string | undefined {
  return key !== undefined && key.type === 'property' ? key.propertyTypeId : undefined;
}

/** The ORDER BY property a hop cardinality names, when its key is a bare
 *  property of the landed record. */
export function hopOrderProperty(cardinality: HopCardinality): string | undefined {
  return orderKeyProperty(hopOrderKey(cardinality));
}

/**
 * Sort `items` by an ASYNCHRONOUS key read, stably. Empty keys sort last
 * regardless of direction (an element nobody can rank goes to the end either
 * way), and ties keep the order the items arrived in.
 */
export async function sortByOrderKey<T>(
  items: T[],
  direction: 'asc' | 'desc' | undefined,
  options: { value: (item: T) => Promise<unknown> },
): Promise<T[]> {
  const keyed = await Promise.all(
    items.map(async (item, index) => ({ item, index, key: await options.value(item) })),
  );
  const sign = direction === 'desc' ? -1 : 1;
  keyed.sort((a, b) => {
    const byKey = compareOrderValues(a.key, b.key);
    if (byKey !== 0) {
      const aEmpty = a.key === null || a.key === undefined;
      const bEmpty = b.key === null || b.key === undefined;
      if (aEmpty || bEmpty) return byKey;
      return byKey * sign;
    }
    return a.index - b.index;
  });
  return keyed.map((k) => k.item);
}

/**
 * Apply one hop's ORDER BY / LIMIT to the records it yielded from ONE origin
 * position. `value` evaluates the hop's ordering KEY against an item — a
 * property of the landed record, a short path off it, anything the element
 * scope can answer — through whatever seam the item reads by.
 */
export async function applyHopOrderLimit<T>(
  items: T[],
  cardinality: HopCardinality,
  options: { value: (item: T) => Promise<unknown> },
): Promise<T[]> {
  if (!cardinality) return items;
  let result = items;
  if (cardinality.orderBy !== undefined) {
    result = await sortByOrderKey(result, cardinality.orderDirection, options);
  }
  if (cardinality.limit !== undefined) {
    result = result.slice(0, cardinality.limit);
  }
  return result;
}

/**
 * What ONE hop pushes to the adapter for its fetch — the WHERE (only when
 * pure), the ORDER BY the bracket names, and the LIMIT. Every walker builds
 * its adapter call from this, so a hop fetches the same way wherever it is
 * written: at the head of a block, inside an expression, or inside EXISTS.
 *
 * Pushing is an OPTIMISATION, never the guarantee: an adapter may honour any,
 * all or none of it, and each walker still post-filters, then sorts and slices
 * through `applyHopOrderLimit` over whatever came back. The one rule an adapter
 * must keep is the contract on `limit` (see `GetRelatedInput.limit`): a limit
 * may only be honoured alongside the sort it came with.
 */
export function hopPushdown(step: Pick<EdgeStep, 'cardinality' | 'expressionFilter'>): {
  where?: Expression;
  orderBy?: { fieldId: string; direction: 'asc' | 'desc' };
  limit?: number;
} {
  // An IMPURE WHERE (an `AI()`, a sub-traversal) can't cross the seam — no
  // adapter can evaluate it — so it stays entirely with the engine's
  // post-filter. The checker gates those to bounded edges.
  const where =
    step.expressionFilter !== undefined && isPurePredicate(step.expressionFilter)
      ? step.expressionFilter
      : undefined;
  // A key that is not a bare property of the landed record cannot cross the
  // seam — the adapter has no such column to sort by — so the sort stays here,
  // and with it the LIMIT: a truncated fetch followed by an engine sort would
  // answer the wrong records (`GetRelatedInput.limit`'s contract, D1).
  const orderKey = hopOrderKey(step.cardinality);
  const orderProperty = orderKeyProperty(orderKey);
  const pushesOrder = orderKey === undefined || orderProperty !== undefined;
  return {
    ...(where !== undefined ? { where } : {}),
    ...(orderProperty !== undefined
      ? {
          orderBy: {
            fieldId: orderProperty,
            direction: step.cardinality?.orderDirection ?? 'asc',
          },
        }
      : {}),
    ...(pushesOrder && step.cardinality?.limit !== undefined
      ? { limit: step.cardinality.limit }
      : {}),
  };
}
