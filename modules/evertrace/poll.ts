// Evertrace's poll (adapter protocol 2.6): Evertrace has no webhooks, so the
// host polls each listenable edge once for every listen sharing a connection
// and a taken filter. `Signals` is each signal created since the cursor;
// `List Entries` is each signal added to a list since it. Each edge keeps its
// own cursor, the newest `createdAt` delivered.
//
// Creation is the ONE "changed since" Evertrace offers, so a listen hears new
// things only: a signal that changes afterwards does not arrive again, and an
// entry that is removed and re-added arrives as the new entry it is.
//
// The module applies the taken filter itself, so every arrival says
// `takenApplied`: `Saved Search` chooses the saved searches read (Evertrace
// applies their rows), `List Name` the lists read, and the rest is judged over
// what came back.

import { holds, narrowedTo, takenComparisons, type ModuleLog, type PollEdgeAnswer, type PollEdgeInput, type TakenComparison } from 'module-kit';
import type {
  EvertraceApiClient,
  EvertraceList,
  EvertraceListEntry,
  EvertraceSignal,
} from './api_client';

import { landingFields } from './adapter';
import { narrowsAnything, savedSearchFilter } from './saved_search';
import {
  EVERTRACE_LIST_ENTRIES_COLLECTION,
  EVERTRACE_LIST_ENTRY_DISPLAY_NAME,
  EVERTRACE_LIST_ENTRY_TYPE_ID,
  EVERTRACE_LIST_NAME_FIELD,
  EVERTRACE_LIST_NAME_FIELD_ID,
  EVERTRACE_SAVED_SEARCH_FIELD,
  EVERTRACE_SAVED_SEARCH_FIELD_ID,
  EVERTRACE_SIGNALS_COLLECTION,
  EVERTRACE_SIGNAL_DISPLAY_NAME,
  EVERTRACE_SIGNAL_TYPE_ID,
  encodeListEntryId,
  type EvertraceCheckpoint,
} from './types';

/** An arrival that landed (the gone kind is never a poll's). */
type Arrival = Extract<PollEdgeAnswer['arrivals'][number], { landing: unknown }>;

/** Rows per request. Evertrace's envelope carries no total, so a SHORT page is
 *  the end of the collection. */
const PAGE_SIZE = 100;

/** The list-entry poll walks newest-first pages; this bounds how far back it
 *  will walk when the cutoff is never reached (a list that has been quiet is
 *  otherwise paged in full on every tick). */
const MAX_LIST_PAGES = 20;

/** Saved searches whose stored rows have already been logged, so the raw
 *  vocabulary reaches production logs ONCE per search per process rather than
 *  on every tick. */
const loggedSearches = new Set<string>();

function mark(cursor: unknown): number | undefined {
  if (typeof cursor !== 'object' || cursor === null) return undefined;
  const value: unknown = Reflect.get(cursor, 'createdAfter');
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The texts a taken filter names on `names` (a field by either spelling), and
 *  the taken comparisons that are not about it. A comparison on it that does
 *  not narrow to texts stays with the rest, judged over what came back. */
function split(taken: readonly TakenComparison[], names: readonly string[]): { named: string[]; rest: TakenComparison[] } {
  const named: string[] = [];
  const rest: TakenComparison[] = [];
  for (const comparison of taken) {
    const texts = names.includes(comparison.field) ? narrowedTo(comparison) : undefined;
    if (texts === undefined) rest.push(comparison);
    else named.push(...texts);
  }
  return { named, rest };
}

export async function pollEvertrace(client: EvertraceApiClient, input: PollEdgeInput, options: { log: ModuleLog }): Promise<PollEdgeAnswer> {
  if (input.edge !== EVERTRACE_SIGNALS_COLLECTION && input.edge !== EVERTRACE_LIST_ENTRIES_COLLECTION) {
    throw new Error(
      `@lf/evertrace: no edge ${input.edge} to poll (its listenable edges are ${EVERTRACE_SIGNALS_COLLECTION} and ${EVERTRACE_LIST_ENTRIES_COLLECTION})`,
    );
  }
  const since = mark(input.cursor);

  // First poll: set the mark to now and deliver nothing. A live listen hears
  // from go-live onward — it never backfills the corpus (which would flood the
  // run on connect). What was there stays reachable by walking `Signals`, or a
  // list's `Entries`.
  if (since === undefined) return { arrivals: [], cursor: { createdAfter: Date.now() } satisfies EvertraceCheckpoint };

  const taken = takenComparisons(input.filter);
  const read =
    input.edge === EVERTRACE_SIGNALS_COLLECTION
      ? await signalArrivals({ client, since, taken, log: options.log })
      : await entryArrivals({ client, since, taken });

  // Oldest first — a run processes what Evertrace found in the order it found it.
  read.arrivals.sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''));
  return { arrivals: read.arrivals, cursor: { createdAfter: read.newest } satisfies EvertraceCheckpoint };
}

interface Read {
  arrivals: Arrival[];
  /** The newest `createdAt` seen, delivered or not, so none is read again. */
  newest: number;
}

/** The signals created since the mark: through each saved search the filter
 *  names (a signal two of them match arrives once), else all of them. */
async function signalArrivals(input: {
  client: EvertraceApiClient;
  since: number;
  taken: readonly TakenComparison[] | undefined;
  log: ModuleLog;
}): Promise<Read> {
  const { named: searches, rest } = split(input.taken ?? [], [EVERTRACE_SAVED_SEARCH_FIELD, EVERTRACE_SAVED_SEARCH_FIELD_ID]);
  const found = new Map<string, { signal: EvertraceSignal; search?: string }>();
  if (searches.length === 0) {
    for (const signal of await signalsSinceCreation({ client: input.client, createdAfter: input.since })) found.set(signal.id, { signal });
  }
  for (const search of searches) {
    for (const signal of await signalsFromSearch({ client: input.client, log: input.log, search, createdAfter: input.since })) {
      if (!found.has(signal.id)) found.set(signal.id, { signal, search });
    }
  }
  const arrivals = [...found.values()]
    .map(({ signal, search }): Arrival => ({
      edge: EVERTRACE_SIGNALS_COLLECTION,
      identity: signal.id,
      landing: {
        recordId: signal.id,
        recordType: EVERTRACE_SIGNAL_DISPLAY_NAME,
        fields: landingFields(EVERTRACE_SIGNAL_TYPE_ID, { ...signal, ...(search !== undefined ? { [EVERTRACE_SAVED_SEARCH_FIELD_ID]: search } : {}) }),
      },
      occurredAt: new Date(signal.createdAt).toISOString(),
      ...(input.taken !== undefined ? { takenApplied: true } : {}),
    }))
    .filter((arrival) => rest.every((comparison) => holds(arrival.landing.fields[comparison.field], comparison)));
  return { arrivals, newest: Math.max(input.since, ...[...found.values()].map(({ signal }) => signal.createdAt)) };
}

/** The entries added since the mark, to each list the filter names (by its
 *  name or its id), else to any list in the workspace. */
async function entryArrivals(input: {
  client: EvertraceApiClient;
  since: number;
  taken: readonly TakenComparison[] | undefined;
}): Promise<Read> {
  const { named: lists, rest } = split(input.taken ?? [], [EVERTRACE_LIST_NAME_FIELD, EVERTRACE_LIST_NAME_FIELD_ID]);
  const entries = await entriesSinceCreation({ client: input.client, createdAfter: input.since, lists });
  const arrivals = entries
    .map(({ entry, list }): Arrival => ({
      edge: EVERTRACE_LIST_ENTRIES_COLLECTION,
      identity: encodeListEntryId({ listId: entry.listId, entryId: entry.id }),
      landing: {
        recordId: encodeListEntryId({ listId: entry.listId, entryId: entry.id }),
        recordType: EVERTRACE_LIST_ENTRY_DISPLAY_NAME,
        fields: landingFields(EVERTRACE_LIST_ENTRY_TYPE_ID, { ...entry, [EVERTRACE_LIST_NAME_FIELD_ID]: list.name }),
      },
      about: { recordType: EVERTRACE_SIGNAL_DISPLAY_NAME, externalId: entry.signalId },
      occurredAt: new Date(entry.createdAt).toISOString(),
      ...(input.taken !== undefined ? { takenApplied: true } : {}),
    }))
    .filter((arrival) => rest.every((comparison) => holds(arrival.landing.fields[comparison.field], comparison)));
  return { arrivals, newest: Math.max(input.since, ...entries.map(({ entry }) => entry.createdAt)) };
}

/** The unfiltered poll: Evertrace's own `created_after` does the bounding, so
 *  every page is already new. */
async function signalsSinceCreation(input: {
  client: EvertraceApiClient;
  createdAfter: number;
}): Promise<EvertraceSignal[]> {
  const all: EvertraceSignal[] = [];
  for (let page = 1; ; page++) {
    const { data } = await input.client.listSignals({
      filter: { created_after: String(input.createdAfter) },
      page,
      limit: PAGE_SIZE,
    });
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * The saved-search poll. The search's stored filter rows are rebuilt as the
 * `POST /signals` body and the poll adds its own `created_after` — so this is
 * the unfiltered poll with the search's narrowing on top, and the cutoff is
 * the server's rather than an assumption about the order rows come back in.
 */
async function signalsFromSearch(input: {
  client: EvertraceApiClient;
  log: ModuleLog;
  search: string;
  createdAfter: number;
}): Promise<EvertraceSignal[]> {
  const { found, rows, filter, skipped } = await savedSearchFilter(input.client, input.search);

  if (!loggedSearches.has(found.id)) {
    loggedSearches.add(found.id);
    input.log.info(
      `[evertrace] saved search "${found.title}" (${found.id}) rows: ${JSON.stringify(rows)}`,
    );
    if (skipped.length > 0) {
      input.log.info(
        `[evertrace] saved search "${found.title}" (${found.id}) skipped: ${JSON.stringify(skipped)}`,
      );
    }
  }
  if (!narrowsAnything(filter)) {
    // Every row unreadable would otherwise read as "this search matches
    // everything" — say so, rather than delivering the whole feed in silence.
    input.log.warn(
      `[evertrace] saved search "${found.title}" (${found.id}) contributed no filter; ` +
        `polling on the checkpoint alone`,
    );
  }

  const all: EvertraceSignal[] = [];
  for (let page = 1; ; page++) {
    const { data } = await input.client.listSignals({
      filter: { ...filter, created_after: String(input.createdAfter) },
      page,
      limit: PAGE_SIZE,
    });
    all.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * The list-entry read. Entries live under their list — there is no
 * workspace-wide entry listing and no `created_after` on the one there is — so
 * this asks each list in scope for its newest entries first and stops at the
 * mark. No list named covers every list the workspace has.
 */
async function entriesSinceCreation(input: {
  client: EvertraceApiClient;
  createdAfter: number;
  lists: readonly string[];
}): Promise<Array<{ entry: EvertraceListEntry; list: EvertraceList }>> {
  const all = await input.client.listLists();
  const scope = input.lists.length > 0 ? [...new Set(input.lists.map((named) => resolveList(all, named)))] : all;

  const fresh: Array<{ entry: EvertraceListEntry; list: EvertraceList }> = [];
  for (const list of scope) {
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const { data } = await input.client.listListEntries(list.id, {
        page,
        limit: PAGE_SIZE,
        sortBy: 'entry_created_at',
        sortOrder: 'desc',
      });
      fresh.push(...data.filter((entry) => entry.createdAt > input.createdAfter).map((entry) => ({ entry, list })));
      if (data.length < PAGE_SIZE || data.some((e) => e.createdAt <= input.createdAfter)) break;
    }
  }
  return fresh;
}

/** A list named by its id or by its exact name. */
function resolveList(lists: EvertraceList[], list: string): EvertraceList {
  const match =
    lists.find((l) => l.id === list) ??
    lists.find((l) => l.name.toLowerCase() === list.toLowerCase());
  if (!match) {
    throw new Error(
      `EvertracePollSource: no list called "${list}" in this Evertrace workspace ` +
        `(saw: ${lists.map((l) => l.name).join(', ') || 'none'}).`,
    );
  }
  return match;
}
