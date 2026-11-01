// Dealroom's poll of `Funding Rounds` (adapter protocol 2.6): Dealroom has no
// webhooks anywhere in its API, so the host polls the edge once for every
// listen sharing a connection and a taken filter. Each round recorded since
// the cursor arrives once, oldest first; the cursor is the newest `created_utc`
// delivered.
//
// Creation is the ONE "changed since" Dealroom offers on a round, so a round
// whose amount is corrected afterwards does not arrive again.
//
// The module applies the taken filter itself, so every arrival says
// `takenApplied`. `Round`, `Company Industries` and `Company Locations` go to
// Dealroom's own terms filters, as they have always been, and are not judged
// again here: its taxonomy is wider than the names a round lists (a location
// may be a region). The rest is judged over the round.

import { holds, narrowedTo, takenComparisons, type PollEdgeAnswer, type PollEdgeInput, type TakenComparison } from 'module-kit';

import {
  DEALROOM_MAX_LIMIT,
  DEALROOM_MAX_OFFSET,
  dealroomDateTime,
  parseDealroomInstant,
  type DealroomFundingRound,
  type DealroomMustFilters,
  type DealroomApiClient,
} from './api_client';
import { roundFields } from './adapter';
import { DEALROOM_SEARCH_FIELDS } from './schema';
import {
  DEALROOM_COMPANY_DISPLAY_NAME,
  DEALROOM_COMPANY_INDUSTRIES_FIELD,
  DEALROOM_COMPANY_INDUSTRIES_FIELD_ID,
  DEALROOM_COMPANY_LOCATIONS_FIELD,
  DEALROOM_COMPANY_LOCATIONS_FIELD_ID,
  DEALROOM_FUNDING_ROUNDS_COLLECTION,
  DEALROOM_FUNDING_ROUND_DISPLAY_NAME,
  DEALROOM_FUNDING_ROUND_TYPE_ID,
  type DealroomCheckpoint,
} from './types';

/** An arrival that landed (the gone kind is never a poll's). */
type Arrival = Extract<PollEdgeAnswer['arrivals'][number], { landing: unknown }>;

/**
 * How far one tick will page. `created_utc_min` bounds the query, so a tick only
 * reaches this when a very quiet listener wakes to a very busy day — and then
 * the mark advances anyway, so the rest arrives on the next tick rather than
 * being lost.
 */
const MAX_PAGES = 20;

/** Dealroom's terms filter (`form_data.must` key) for each taken field it
 *  judges, spelled by the field's id and by its name. */
const TERMS_KEY: Record<string, string> = {
  round: 'rounds',
  Round: 'rounds',
  [DEALROOM_COMPANY_INDUSTRIES_FIELD_ID]: 'industries',
  [DEALROOM_COMPANY_INDUSTRIES_FIELD]: 'industries',
  [DEALROOM_COMPANY_LOCATIONS_FIELD_ID]: 'hq_locations',
  [DEALROOM_COMPANY_LOCATIONS_FIELD]: 'hq_locations',
};

function termsOf(comparison: TakenComparison): string[] | undefined {
  if (comparison.op === 'contains') return typeof comparison.value === 'string' ? [comparison.value] : undefined;
  // Dealroom ORs a key's terms: an OR of CONTAINS is what it takes as given.
  if (comparison.op === 'containsAny') return Array.isArray(comparison.value) ? comparison.value.filter((v) => v !== null).map(String) : undefined;
  return narrowedTo(comparison);
}

/**
 * What a taken filter splits into: the terms Dealroom judges, and the
 * comparisons judged here over the round. Dealroom ORs the values of one terms
 * key, so a second comparison on a key already sent (an AND) is judged here.
 */
function split(taken: readonly TakenComparison[]): { must: DealroomMustFilters; here: TakenComparison[] } {
  const must: DealroomMustFilters = {};
  const here: TakenComparison[] = [];
  for (const comparison of taken) {
    const key = TERMS_KEY[comparison.field];
    const terms = key === undefined ? undefined : termsOf(comparison);
    if (key === undefined || terms === undefined || key in must) here.push(comparison);
    else must[key] = terms;
  }
  return { must, here };
}

function mark(cursor: unknown): number | undefined {
  if (typeof cursor !== 'object' || cursor === null) return undefined;
  const value: unknown = Reflect.get(cursor, 'createdAfter');
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function arrival(round: DealroomFundingRound, takenApplied: boolean, now: number): Arrival {
  const id = String(round.id);
  return {
    edge: DEALROOM_FUNDING_ROUNDS_COLLECTION,
    identity: id,
    landing: { recordId: id, recordType: DEALROOM_FUNDING_ROUND_DISPLAY_NAME, fields: roundFields(round) },
    occurredAt: new Date(parseDealroomInstant(round.created_utc) ?? now).toISOString(),
    ...(round.company !== null && round.company !== undefined
      ? { about: { recordType: DEALROOM_COMPANY_DISPLAY_NAME, externalId: String(round.company.id) } }
      : {}),
    ...(takenApplied ? { takenApplied: true } : {}),
  };
}

/** One poll: the rounds recorded since the cursor, oldest first. */
export async function pollDealroom(client: DealroomApiClient, input: PollEdgeInput, now: number = Date.now()): Promise<PollEdgeAnswer> {
  if (input.edge !== DEALROOM_FUNDING_ROUNDS_COLLECTION) {
    throw new Error(`@lf/dealroom: no edge ${input.edge} to poll (its listenable edge is ${DEALROOM_FUNDING_ROUNDS_COLLECTION})`);
  }
  const since = mark(input.cursor);

  // First poll: set the mark to now and deliver nothing. A live listen hears
  // rounds from go-live onward — it never backfills the database (which would
  // flood the run on connect). Past rounds stay reachable by walking
  // `Funding Rounds`.
  if (since === undefined) return { arrivals: [], cursor: { createdAfter: now } satisfies DealroomCheckpoint };

  const taken = takenComparisons(input.filter);
  const { must, here } = split(taken ?? []);
  const rounds = await roundsSinceCreation({ client, createdAfter: since, must });

  const cursor: DealroomCheckpoint = {
    createdAfter: rounds.reduce(
      (high, round) => Math.max(high, parseDealroomInstant(round.created_utc) ?? high),
      since,
    ),
  };

  const arrivals = rounds
    .map((round) => arrival(round, taken !== undefined, now))
    .filter((one) => here.every((comparison) => holds(one.landing.fields[comparison.field], comparison)));

  // Oldest first — a run processes the rounds in the order Dealroom recorded
  // them.
  arrivals.sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''));

  return { arrivals, cursor };
}

/**
 * The rounds recorded since the mark. Dealroom's own `created_utc_min` does the
 * bounding and its `created_utc` sort makes the walk oldest-first, so paging is
 * a plain offset walk. The bound is inclusive over there, so the round that SET
 * the mark comes back — dropped here rather than delivered twice.
 */
async function roundsSinceCreation(input: {
  client: DealroomApiClient;
  createdAfter: number;
  must: DealroomMustFilters;
}): Promise<DealroomFundingRound[]> {
  const fresh: DealroomFundingRound[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * DEALROOM_MAX_LIMIT;
    if (offset > DEALROOM_MAX_OFFSET) break;
    const { items } = await input.client.searchFundingRounds({
      must: { ...input.must, created_utc_min: dealroomDateTime(input.createdAfter) },
      fields: DEALROOM_SEARCH_FIELDS[DEALROOM_FUNDING_ROUND_TYPE_ID],
      sort: 'created_utc',
      limit: DEALROOM_MAX_LIMIT,
      offset,
    });
    for (const round of items) {
      const created = parseDealroomInstant(round.created_utc);
      if (created !== undefined && created <= input.createdAfter) continue;
      fresh.push(round);
    }
    if (items.length < DEALROOM_MAX_LIMIT) break;
  }
  return fresh;
}
