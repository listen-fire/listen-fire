// Narrowing consumes an expression that evaluates to a Boolean.
//
// A WHERE already means "evaluate this predicate over these members" at
// runtime. Saying the same thing at author time gives ONE semantics instead of
// a special equality-against-a-literal case beside it — so any predicate the
// shared filter unit can evaluate composes for free (conjunctions, disjunction,
// negation, nesting), and there is nothing to widen when the language grows.
//
// This module is only the EVALUATION half. Who the members ARE is the caller's
// question, and it has two different answers on purpose:
//
//   - the direct walk (`instance_cache`'s `stepTo`) narrows over the members
//     THIS hop published — it holds them already, and a hop's own edges are
//     what a path step addresses;
//   - the refinement pre-pass narrows over the members the META WALK published
//     (`positionsByName`), because valid members are discovered by traversing
//     from the meta node — not from wherever the author happens to be standing.
//     That is what lets an EVENT's edge narrow to a table: the event never
//     enumerates the tables, the meta walk does.

import { evaluatePredicate, isPurePredicate, leafReadKey, pureLeafReads } from '#shared/expression/filter';
import type { Expression } from '#shared/expression/types';

/** A candidate the predicate runs against: the labelled facts the adapter
 *  minted onto the member's position (Airtable's `{ Name }`, Sheets'
 *  `{ Title }`), plus whatever the caller wants back when it wins. */
export interface NarrowableMember<T> {
  /** The member's published data — the position's `identity.data`, as minted. */
  data: unknown;
  value: T;
}

function readableData(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  return data as Record<string, unknown>;
}

/**
 * The member this predicate selects, or `undefined` for "doesn't narrow".
 *
 * Two gates, and they are why this can never over-claim:
 *
 *   - `isPurePredicate` — an `AI()`, a traversal or a function call can't be
 *     decided without the adapter/LLM/graph, so it doesn't narrow;
 *   - every leaf the predicate reads must be present in the MEMBER'S OWN data.
 *     This is TIGHTER than purity, deliberately: `alias_ref` and `@current_date`
 *     are pure but are RUNTIME values, unknowable while typing.
 *
 * A predicate that decides nothing, matches nothing, or matches a member the
 * adapter minted without data all land in the same place — no refinement, the
 * unnarrowed surface stands, and the runtime guards stay the safety mechanism.
 * That is the pre-existing contract, not a new failure mode.
 *
 * First match wins: members of one type are distinct positions, so a predicate
 * selecting two of them is an author error the type layer can't adjudicate —
 * and picking the first is what a runtime WHERE over an ordered set does.
 */
export function selectMember<T>(input: {
  members: ReadonlyArray<NarrowableMember<T>>;
  filter: Expression;
}): T | undefined {
  const { filter } = input;
  if (!isPurePredicate(filter)) return undefined;
  const reads = pureLeafReads(filter).map(leafReadKey);

  for (const member of input.members) {
    const data = readableData(member.data);
    if (!data || !reads.every((name) => name in data)) continue;
    if (evaluatePredicate(filter, { read: (name) => data[name] }) === true) return member.value;
  }
  return undefined;
}
