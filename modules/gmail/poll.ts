// Gmail's poll of its two listenable edges (adapter protocol 2.6): the
// host polls an edge once for every listen sharing a connection and a taken
// filter. `Messages` is each message added to the mailbox since the mark;
// `Labelings` each label added to a message already in it.
//
// Push was available and deliberately not taken: a Pub/Sub topic, a public push
// endpoint and a watch that must be renewed every week are a lot of moving parts
// to buy a minute of latency nobody needs.
//
// The marker is PERISHABLE — Gmail drops it after about a week of inactivity —
// so the cursor carries a second mark, the last seen time, and an expired
// marker resyncs from that rather than leaving the listen dead forever.
//
// History is exact but Gmail's SEARCH, which applies the listen's `Query`,
// only catches up eventually. An arrival the search does not admit yet rides
// the cursor as pending and is re-checked on later polls, so a slow index
// delays a message rather than losing it.
//
// The module applies the whole taken filter itself — `Query` and labels
// upstream, the rest over what it fetched — so every arrival says
// `takenApplied`, and a label named as a person sees it (`"Deals"`) matches
// the label id the message carries.

import { holds, takenComparisons, type PollEdgeAnswer, type PollEdgeInput, type TakenComparison } from 'module-kit';
import type { GmailClientSource } from './adapter';

import {
  GmailApiError,
  type GmailApiClient,
  type GmailLabel,
  type GmailHistoryAddition,
  type GmailHistoryType,
  type GmailLabelAddition,
  type GmailMessageRef,
} from './api_client';
import { LabelNames, isSystemLabel } from './label_names';
import { decodeGmailMessage, type GmailMessageRecord } from './mime';
import { combineGmailQueries } from './filter';
import { labelingLandingFields, messageLandingFields } from './schema';
import {
  GMAIL_LABELINGS_COLLECTION,
  GMAIL_LABELING_DISPLAY_NAME,
  GMAIL_MESSAGES_COLLECTION,
  GMAIL_MESSAGE_DISPLAY_NAME,
  GMAIL_QUERY_FIELD,
  type GmailCheckpoint,
  type GmailPendingArrival,
} from './types';

/** An arrival that landed (the gone kind is never a poll's). */
type Arrival = Extract<PollEdgeAnswer['arrivals'][number], { landing: unknown }>;

/** Gmail's search leaves these out unless the request asks for them. */
const SPAM_AND_TRASH = new Set(['SPAM', 'TRASH']);

/** How many changes one poll will deliver. A poll that meets more than this
 *  advances the mark only over what it took, so the rest arrives on the next
 *  poll rather than being lost. */
const MAX_PER_TICK = 100;

/** How far back a resync reaches when the cursor carries no last seen time
 *  — which can only happen to a row written before both marks existed. */
const RESYNC_FALLBACK_MS = 24 * 60 * 60 * 1000;

/** How long an arrival the listen's search does not admit is re-checked
 *  before it counts as excluded. Gmail's search index trails its history by
 *  seconds to minutes; past this, the query genuinely does not match. */
const PENDING_GRACE_MS = 15 * 60 * 1000;

/** How many search pages one narrowing reads looking for the ids in hand —
 *  enough for a busy poll, bounded so a broad query cannot page the mailbox.
 *  An id not found stays pending rather than being dropped. */
const NARROW_MAX_PAGES = 5;

const LABEL_FIELD = 'Label';
const LABEL_TYPE_FIELD = 'Label Type';
const LABELS_FIELD = 'Labels';

function checkpointOf(value: unknown): GmailCheckpoint {
  if (typeof value !== 'object' || value === null) return {};
  const historyId = Reflect.get(value, 'historyId');
  const lastSeenAt = Reflect.get(value, 'lastSeenAt');
  const pending = pendingOf(Reflect.get(value, 'pending'));
  return {
    ...(typeof historyId === 'string' && historyId !== '' ? { historyId } : {}),
    ...(typeof lastSeenAt === 'string' && lastSeenAt !== '' ? { lastSeenAt } : {}),
    ...(pending.length > 0 ? { pending } : {}),
  };
}

/** A cursor written before `pending` existed has none; an entry that does
 *  not parse is dropped rather than failing the listen. */
function pendingOf(value: unknown): GmailPendingArrival[] {
  if (!Array.isArray(value)) return [];
  const out: GmailPendingArrival[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const id = Reflect.get(entry, 'id');
    const firstSeenAt = Reflect.get(entry, 'firstSeenAt');
    if (typeof id !== 'string' || id === '') continue;
    if (typeof firstSeenAt !== 'string' || Number.isNaN(Date.parse(firstSeenAt))) continue;
    out.push({ id, firstSeenAt });
  }
  return out;
}

/**
 * The labels a listen names, as ids (what history and a message carry) and
 * names (what Gmail's search takes). A system label is its own id and name; a
 * user label may be written either way, and is looked up once per poll. One
 * the mailbox does not have fails the poll, naming the labels it does have.
 */
async function resolveLabels(client: GmailApiClient, names: LabelNames, written: readonly string[]): Promise<GmailLabel[]> {
  if (written.every(isSystemLabel)) return written.map((id) => ({ id, name: id }));
  const known = await names.list();
  return written.map((label) => {
    if (isSystemLabel(label)) return { id: label, name: label };
    const found =
      known.find((k) => k.id === label) ??
      known.find((k) => k.name === label) ??
      known.find((k) => k.name.toLowerCase() === label.toLowerCase());
    if (found === undefined) {
      const theirs = known.filter((k) => !isSystemLabel(k.id)).map((k) => k.name);
      throw new Error(
        `a Gmail listen names the label '${label}', which ${client.credentials.mailbox} does not have — ` +
          `its labels are ${theirs.length > 0 ? theirs.join(', ') : 'none of its own'} (or a system label such as INBOX)`,
      );
    }
    return found;
  });
}

/** The listened edge, by name. */
type ListenedEdge = typeof GMAIL_MESSAGES_COLLECTION | typeof GMAIL_LABELINGS_COLLECTION;

function listenedEdge(edge: string): ListenedEdge {
  if (edge === GMAIL_MESSAGES_COLLECTION || edge === GMAIL_LABELINGS_COLLECTION) return edge;
  throw new Error(`@lf/gmail: no edge ${edge} to poll (its listenable edges are ${GMAIL_MESSAGES_COLLECTION} and ${GMAIL_LABELINGS_COLLECTION})`);
}

/**
 * What one poll of an edge reads, from the filter the listens sharing it
 * take: Gmail's search (`Query`), the labels it reads history by (a
 * message's `Labels CONTAINS`, every one held; a labeling's `Label`, any one
 * named), and the rest, judged over what it fetched.
 */
interface Watch {
  edge: ListenedEdge;
  query?: string;
  labels?: string[];
  /** A message's ORs of `Labels CONTAINS` (`containsAny`): one of each held. */
  anyLabels?: string[][];
  rest: TakenComparison[];
  /** False when the filter has a part this cannot read: the host judges it all. */
  applied: boolean;
}

export function watchOf(edge: string, filter: unknown): Watch {
  const listened = listenedEdge(edge);
  const taken = takenComparisons(filter);
  if (taken === undefined) return { edge: listened, rest: [], applied: false };
  const queries: string[] = [];
  const labels: string[] = [];
  const anyLabels: string[][] = [];
  let labelling: string[] | undefined;
  const rest: TakenComparison[] = [];
  for (const comparison of taken) {
    const { field, op, value } = comparison;
    if (field === GMAIL_QUERY_FIELD && op === 'eq' && typeof value === 'string') {
      queries.push(value.trim());
    } else if (listened === GMAIL_MESSAGES_COLLECTION && field === LABELS_FIELD && op === 'contains' && typeof value === 'string') {
      labels.push(value.trim());
    } else if (listened === GMAIL_MESSAGES_COLLECTION && field === LABELS_FIELD && op === 'containsAny' && Array.isArray(value)) {
      anyLabels.push([...new Set(value.map((label) => String(label).trim()))]);
    } else if (listened === GMAIL_LABELINGS_COLLECTION && field === LABEL_FIELD && labelling === undefined && (op === 'eq' || op === 'in')) {
      labelling = (Array.isArray(value) ? value : [value]).map(String);
    } else {
      rest.push(comparison);
    }
  }
  const query = combineGmailQueries(...queries);
  const named = listened === GMAIL_MESSAGES_COLLECTION ? labels : labelling;
  return {
    edge: listened,
    ...(query !== undefined ? { query } : {}),
    ...(named !== undefined && named.length > 0 ? { labels: [...new Set(named)] } : {}),
    ...(anyLabels.length > 0 ? { anyLabels } : {}),
    rest,
    applied: true,
  };
}

/**
 * What one poll reads of history. A message listen naming labels it must
 * hold reads the history of the first (every arrival must carry them all);
 * one naming none, or only labels of which it must hold one, reads the whole
 * mailbox. A labeling listen reads each label it names, or the whole mailbox
 * for any label.
 */
interface WatchPlan {
  reads: { labelId?: string; types: GmailHistoryType[] }[];
  /** Whether an added label counts. */
  counts: (label: string) => boolean;
  /** The search terms that narrow by the labels (each Gmail's AND). */
  labelTerms: string[];
  includeSpamTrash: boolean;
}

function watchPlan(edge: ListenedEdge, named: GmailLabel[] | undefined, anyOf: GmailLabel[][] = []): WatchPlan {
  const term = (label: GmailLabel) => `label:${/[\s():]/.test(label.name) ? `"${label.name}"` : label.name}`;
  // Gmail's braces are an OR of the terms inside them.
  const terms = [...(named ?? []).map(term), ...anyOf.map((group) => (group.length === 1 ? term(group[0]) : `{${group.map(term).join(' ')}}`))];
  const spamOrTrash = (named === undefined && anyOf.length === 0) || [...(named ?? []), ...anyOf.flat()].some((label) => SPAM_AND_TRASH.has(label.id));
  if (edge === GMAIL_MESSAGES_COLLECTION) {
    const first = named?.[0];
    return {
      reads: [{ ...(first !== undefined ? { labelId: first.id } : {}), types: ['messageAdded'] }],
      counts: () => false,
      labelTerms: terms,
      includeSpamTrash: spamOrTrash,
    };
  }
  if (named === undefined) return { reads: [{ types: ['labelAdded'] }], counts: () => true, labelTerms: [], includeSpamTrash: true };
  const ids = new Set(named.map((label) => label.id));
  return {
    reads: named.map((label) => ({ labelId: label.id, types: ['labelAdded'] })),
    counts: (label) => ids.has(label),
    labelTerms: [],
    includeSpamTrash: true,
  };
}

/** Gmail's `after:` takes whole epoch SECONDS, and is inclusive — so a resync
 *  asks from the last seen second and the host drops what it already
 *  delivered. */
function afterTerm(sinceMs: number): string {
  return `after:${Math.floor(sinceMs / 1000)}`;
}

function searchOf(plan: WatchPlan, terms: (string | undefined)[]): { query: string; includeSpamTrash?: true } {
  const query = combineGmailQueries(...plan.labelTerms, ...terms) ?? '';
  return plan.includeSpamTrash ? { query, includeSpamTrash: true } : { query };
}

/** Whether every taken comparison the poll did not apply upstream holds of a
 *  landing's fields. */
function holdsAll(fields: Record<string, unknown>, rest: readonly TakenComparison[]): boolean {
  return rest.every((comparison) => holds(fields[comparison.field], comparison));
}

/** One mailbox's poll, over the client its host's credential reaches it with. */
export class GmailPollSource {
  constructor(private readonly client: GmailClientSource) {}

  async poll(input: PollEdgeInput): Promise<PollEdgeAnswer> {
    const watch = watchOf(input.edge, input.filter);
    const client = await this.client();
    const names = new LabelNames(client);
    const named = watch.labels === undefined ? undefined : await resolveLabels(client, names, watch.labels);
    const anyOf: GmailLabel[][] = [];
    for (const group of watch.anyLabels ?? []) anyOf.push(await resolveLabels(client, names, group));
    const plan = watchPlan(watch.edge, named, anyOf);

    const now = Date.now();
    const mark = checkpointOf(input.cursor);

    // First poll: take the mailbox's current marker and deliver nothing. A
    // live listen hears from go-live onward — it never backfills the mailbox
    // (which would flood the run on connect). Past mail stays reachable
    // through the root's `Messages` collection.
    if (mark.historyId === undefined) {
      const profile = await client.getProfile();
      return { arrivals: [], cursor: { historyId: profile.historyId, lastSeenAt: new Date(now).toISOString() } };
    }

    const messages = watch.edge === GMAIL_MESSAGES_COLLECTION;
    const { refs, labelled, historyId } = await this.changes({ client, historyId: mark.historyId, lastSeenAt: mark.lastSeenAt, plan, messages, query: watch.query, now });

    let arrivals: Arrival[];
    let pending: GmailPendingArrival[] = [];
    if (messages) {
      // Arrivals carried over from earlier polls go through the same
      // narrowing as this poll's: one the search now admits arrives now.
      const fresh = new Set(refs.map((ref) => ref.id));
      const carried = (mark.pending ?? []).filter((entry) => !fresh.has(entry.id));
      const candidates = [...refs, ...carried.map((entry) => ({ id: entry.id }))];
      const { fetched, unadmitted } = await this.fetchMessages({ client, refs: candidates, plan, query: watch.query });
      const firstSeen = new Map(carried.map((entry) => [entry.id, entry.firstSeenAt]));
      for (const id of unadmitted) {
        const firstSeenAt = firstSeen.get(id) ?? new Date(now).toISOString();
        if (now - Date.parse(firstSeenAt) < PENDING_GRACE_MS) pending.push({ id, firstSeenAt });
      }
      const held = new Set((named ?? []).map((label) => label.id));
      // Held by id, as history and the message carry them; delivered by name.
      const holding = fetched
        .filter((message) => [...held].every((id) => message.labels.includes(id)))
        .filter((message) => anyOf.every((group) => group.some((label) => message.labels.includes(label.id))))
        // Oldest first — a run handles the mail in the order it arrived.
        .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
      arrivals = (await names.named(holding))
        .map((message) => messageArrival(message, watch))
        .filter((arrival) => holdsAll(arrival.landing.fields, watch.rest));
    } else {
      arrivals = await this.labelArrivals({ client, names, labelled, watch });
    }

    // `lastSeenAt` is the moment this poll LOOKED, not the newest message's own
    // date: a resync from it asks Gmail for everything since the last look,
    // which is the question the missing marker left unanswered. Anything the
    // overlap re-delivers is dropped by its identity.
    const cursor: GmailCheckpoint = {
      historyId: historyId ?? mark.historyId,
      lastSeenAt: new Date(now).toISOString(),
      ...(pending.length > 0 ? { pending } : {}),
    };
    return { arrivals, cursor };
  }

  /**
   * What has arrived, and which watched labels were added, since the mark.
   *
   * The normal path is Gmail's own history, which is cheap and exact. When
   * Gmail has DROPPED the marker — the 404 it gives after about a week of
   * inactivity — arrivals come from a search from the last seen time instead.
   * Label additions have no such search (a message's labels say what it
   * carries, not when each was added), so a resync delivers NONE: the
   * additions in the lost stretch are skipped, never replayed as new, and the
   * mark restarts from the mailbox's current one.
   */
  private async changes(input: {
    client: GmailApiClient;
    historyId: string;
    lastSeenAt: string | undefined;
    plan: WatchPlan;
    messages: boolean;
    query: string | undefined;
    now: number;
  }): Promise<{ refs: GmailMessageRef[]; labelled: GmailLabelAddition[]; historyId?: string }> {
    const { client, plan } = input;
    try {
      const reads: LabelHistory[] = [];
      for (const read of plan.reads) {
        reads.push(await readLabelHistory({ client, startHistoryId: input.historyId, ...read }));
      }
      return takeChanges(reads, { arrivals: input.messages, counts: plan.counts });
    } catch (error) {
      if (!(error instanceof GmailApiError) || error.failure !== 'history_expired') throw error;
    }

    const profile = await client.getProfile();
    if (!input.messages) return { refs: [], labelled: [], historyId: profile.historyId };
    const sinceMs = input.lastSeenAt ? Date.parse(input.lastSeenAt) : NaN;
    const since = Number.isNaN(sinceMs) ? input.now - RESYNC_FALLBACK_MS : sinceMs;
    const { messages } = await client.listMessages({ ...searchOf(plan, [afterTerm(since), input.query]), maxResults: MAX_PER_TICK });
    return { refs: dedupe(messages), labelled: [], historyId: profile.historyId };
  }

  /**
   * One arrival per counted label added to a message, narrowed by the
   * listen's query and the rest of its filter. The message existed before it
   * was labelled, so the search has long caught up on it: one the query does
   * not admit is excluded, not pending. A message deleted since it was
   * labelled is skipped.
   */
  private async labelArrivals(input: { client: GmailApiClient; names: LabelNames; labelled: GmailLabelAddition[]; watch: Watch }): Promise<Arrival[]> {
    const { watch } = input;
    // What the addition alone says is judged before a message is fetched.
    const own = new Set([LABEL_FIELD, LABEL_TYPE_FIELD]);
    const additions: NamedAddition[] = [];
    for (const change of input.labelled) {
      const label = await input.names.nameOf(change.label);
      if (holdsAll({ [LABEL_FIELD]: label, [LABEL_TYPE_FIELD]: labelTypeOf(change.label) }, watch.rest.filter((c) => own.has(c.field)))) additions.push({ change, label });
    }
    if (additions.length === 0) return [];
    const plan: WatchPlan = { reads: [], counts: () => true, labelTerms: [], includeSpamTrash: true };
    const allowed = await this.narrow({ client: input.client, refs: additions.map(({ change }) => change), plan, query: watch.query });
    const fetched = new Map<string, GmailMessageRecord | null>();
    const arrivals: Arrival[] = [];
    for (const addition of additions) {
      const { change } = addition;
      if (!allowed.has(change.id)) continue;
      if (!fetched.has(change.id)) fetched.set(change.id, await messageOrGone(input.client, change.id));
      const message = fetched.get(change.id);
      if (message === undefined || message === null) continue;
      const [named] = await input.names.named([message]);
      const arrival = labelingArrival(named ?? message, addition, watch);
      if (holdsAll(arrival.landing.fields, watch.rest)) arrivals.push(arrival);
    }
    return arrivals;
  }

  /**
   * The messages behind the refs, narrowed by the listen's search.
   *
   * History does not take a query, so a listen with one narrows HERE — a
   * search whose answer is intersected with the ids in hand, which is a page
   * or two of ids rather than a fetch per message that is then thrown away.
   * The ids the search did NOT admit come back too: the caller decides whether
   * the index has not caught up yet or the query excludes them.
   */
  private async fetchMessages(input: {
    client: GmailApiClient;
    refs: GmailMessageRef[];
    plan: WatchPlan;
    query: string | undefined;
  }): Promise<{ fetched: GmailMessageRecord[]; unadmitted: string[] }> {
    if (input.refs.length === 0) return { fetched: [], unadmitted: [] };
    const allowed = await this.narrow(input);
    const fetched: GmailMessageRecord[] = [];
    const unadmitted: string[] = [];
    for (const ref of input.refs) {
      if (!allowed.has(ref.id)) {
        unadmitted.push(ref.id);
        continue;
      }
      fetched.push(decodeGmailMessage(await input.client.getMessage(ref.id)));
    }
    return { fetched, unadmitted };
  }

  /** The subset of ids the listen's own query admits. No query ⇒ all of
   *  them, and no request — history was already read per label. */
  private async narrow(input: { client: GmailApiClient; refs: GmailMessageRef[]; plan: WatchPlan; query: string | undefined }): Promise<Set<string>> {
    const wanted = new Set(input.refs.map((ref) => ref.id));
    if (input.query === undefined) return wanted;
    const admitted = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < NARROW_MAX_PAGES; page += 1) {
      const result = await input.client.listMessages({
        ...searchOf(input.plan, [input.query]),
        maxResults: MAX_PER_TICK,
        ...(pageToken !== undefined ? { pageToken } : {}),
      });
      for (const message of result.messages) {
        if (wanted.has(message.id)) admitted.add(message.id);
      }
      pageToken = result.nextPageToken;
      if (pageToken === undefined || admitted.size === wanted.size) break;
    }
    return admitted;
  }
}

function labelTypeOf(label: string): 'system' | 'user' {
  return isSystemLabel(label) ? 'system' : 'user';
}

/** A message added to the mailbox, as it lands on `Messages`. It carries the
 *  search its poll made as its `Query`, so the host's own check agrees. */
function messageArrival(message: GmailMessageRecord, watch: Watch): Arrival {
  const record = { ...message, ...(watch.query !== undefined ? { query: watch.query } : {}) };
  return {
    edge: GMAIL_MESSAGES_COLLECTION,
    identity: message.id,
    landing: { recordId: message.id, recordType: GMAIL_MESSAGE_DISPLAY_NAME, fields: messageLandingFields(record) },
    ...(message.date !== null ? { occurredAt: message.date } : {}),
    ...(watch.applied ? { takenApplied: true } : {}),
  };
}

/** A label addition from history (which names the label by id), with the
 *  label's name. */
interface NamedAddition {
  change: GmailLabelAddition;
  label: string;
}

/** A label added to a message, as it lands on `Labelings`: its own, keyed by
 *  where in the mailbox's history it happened (by the label's id, which
 *  outlives a rename), so a label removed and added again is a second one;
 *  about its message. It carries the label by name. */
function labelingArrival(message: GmailMessageRecord, added: NamedAddition, watch: Watch): Arrival {
  const { change, label } = added;
  const id = `${message.id}:${change.label}:${change.historyId ?? ''}`;
  const record = {
    ...message,
    labelingId: id,
    label,
    labelType: labelTypeOf(change.label),
    ...(watch.query !== undefined ? { query: watch.query } : {}),
  };
  return {
    edge: GMAIL_LABELINGS_COLLECTION,
    identity: id,
    landing: { recordId: id, recordType: GMAIL_LABELING_DISPLAY_NAME, fields: labelingLandingFields(record) },
    about: { recordType: GMAIL_MESSAGE_DISPLAY_NAME, externalId: message.id },
    ...(watch.applied ? { takenApplied: true } : {}),
  };
}

/** One label's history since the mark, read page by page. */
interface LabelHistory {
  added: GmailHistoryAddition[];
  labelled: GmailLabelAddition[];
  /** The mailbox's marker as this read finished — only meaningful when it
   *  read to the end. */
  historyId?: string;
  /** False when the read stopped early at the tick's cap with pages left. */
  complete: boolean;
}

/**
 * Every page of one label's history, stopping once a tick's worth is in hand —
 * what lies past that stays in Gmail's history for the next tick, because the
 * mark only advances over what was taken.
 */
async function readLabelHistory(input: {
  client: GmailApiClient;
  startHistoryId: string;
  /** Absent: the whole mailbox. */
  labelId?: string;
  types: readonly GmailHistoryType[];
}): Promise<LabelHistory> {
  const added: GmailHistoryAddition[] = [];
  const labelled: GmailLabelAddition[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const page = await input.client.listHistory({
      startHistoryId: input.startHistoryId,
      ...(input.labelId !== undefined ? { labelId: input.labelId } : {}),
      types: input.types,
      ...(pageToken !== undefined ? { pageToken } : {}),
    });
    added.push(...page.added);
    labelled.push(...page.labelled);
    pageToken = page.nextPageToken;
    if (pageToken === undefined) {
      return {
        added,
        labelled,
        ...(page.historyId !== undefined ? { historyId: page.historyId } : {}),
        complete: true,
      };
    }
    if (added.length + labelled.length >= MAX_PER_TICK) return { added, labelled, complete: false };
  }
}

/** A history id as a number to order by — Gmail's are decimal strings that
 *  outgrow a double. */
function historyOrder(id: string | undefined): bigint | undefined {
  return id !== undefined && /^\d+$/.test(id) ? BigInt(id) : undefined;
}

function minOrder(values: (bigint | undefined)[]): bigint | undefined {
  let min: bigint | undefined;
  for (const value of values) {
    if (value !== undefined && (min === undefined || value < min)) min = value;
  }
  return min;
}

/** One change history recorded: a message arriving, or a label being added
 *  to one. */
type HistoryChange =
  | { kind: 'arrived'; ref: GmailHistoryAddition }
  | { kind: 'labelled'; ref: GmailLabelAddition };

function changeKey(change: HistoryChange): string {
  switch (change.kind) {
    case 'arrived':
      return `arrived:${change.ref.id}`;
    case 'labelled':
      // The same record read off two labels' histories is one; the label
      // added again later is another.
      return `labelled:${change.ref.id}:${change.ref.label}:${change.ref.historyId ?? ''}`;
    default:
      return unreachable(change);
  }
}

function unreachable(value: never): never {
  throw new Error(`GmailPollSource: an unknown history change ${JSON.stringify(value)}`);
}

/** The newest history id a read holds, of any kind. */
function lastOrder(read: LabelHistory): bigint | undefined {
  let max: bigint | undefined;
  for (const ref of [...read.added, ...read.labelled]) {
    const at = historyOrder(ref.historyId);
    if (at !== undefined && (max === undefined || at > max)) max = at;
  }
  return max;
}

/**
 * The union of every label's changes the listen asked for, and the mark the
 * next tick reads from. A label addition counts only for a label the plan
 * counts: Gmail's label filter returns every change to a message CARRYING the
 * label, which includes other labels being added to it.
 *
 * When everything was read and taken, the mark is the mailbox's marker — the
 * LOWEST the reads reported, since a message landing on one label between two
 * labels' reads is only covered from the earlier one. When the tick stopped
 * short, the mark sits just before the first change it did not take, so the
 * next tick starts there; whatever it re-reads was already delivered and is
 * dropped by its identity.
 */
function takeChanges(
  reads: LabelHistory[],
  wanted: { arrivals: boolean; counts: (label: string) => boolean },
): { refs: GmailMessageRef[]; labelled: GmailLabelAddition[]; historyId?: string } {
  const seen = new Set<string>();
  const all: HistoryChange[] = [];
  for (const read of reads) {
    const changes: HistoryChange[] = [
      ...(wanted.arrivals ? read.added : []).map((ref) => ({ kind: 'arrived' as const, ref })),
      ...read.labelled.filter((ref) => wanted.counts(ref.label)).map((ref) => ({ kind: 'labelled' as const, ref })),
    ];
    for (const change of changes) {
      const key = changeKey(change);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(change);
    }
  }
  const ordered = [...all].sort((a, b) => {
    const x = historyOrder(a.ref.historyId);
    const y = historyOrder(b.ref.historyId);
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
    return x < y ? -1 : x > y ? 1 : 0;
  });

  // An unfinished label vouches only for what it read — past its last
  // change, the other labels' changes are not yet comparable with its own.
  const frontier = minOrder(reads.filter((read) => !read.complete).map(lastOrder));
  const eligible =
    frontier === undefined
      ? ordered
      : ordered.filter((change) => {
          const at = historyOrder(change.ref.historyId);
          return at !== undefined && at <= frontier;
        });
  const taken = eligible.slice(0, MAX_PER_TICK);
  const refs: GmailMessageRef[] = [];
  const labelled: GmailLabelAddition[] = [];
  for (const change of taken) {
    switch (change.kind) {
      case 'arrived': {
        const { id, threadId } = change.ref;
        refs.push({ id, ...(threadId != null ? { threadId } : {}) });
        break;
      }
      case 'labelled':
        labelled.push(change.ref);
        break;
      default:
        unreachable(change);
    }
  }

  const everything = frontier === undefined && taken.length === ordered.length;
  if (everything) {
    const marker = minOrder(reads.map((read) => historyOrder(read.historyId)));
    return { refs, labelled, ...(marker !== undefined ? { historyId: String(marker) } : {}) };
  }
  const next = historyOrder(eligible[taken.length]?.ref.historyId);
  const resume = next !== undefined ? next - 1n : frontier;
  return { refs, labelled, ...(resume !== undefined ? { historyId: String(resume) } : {}) };
}

/** A message by id, or null when it has been deleted since history saw it. */
async function messageOrGone(client: GmailApiClient, id: string): Promise<GmailMessageRecord | null> {
  try {
    return decodeGmailMessage(await client.getMessage(id));
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) return null;
    throw error;
  }
}

/** One event per message per tick. Gmail's history records a message once per
 *  CHANGE, so a message that arrived and was then labelled appears twice. */
function dedupe<T extends GmailMessageRef>(refs: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const ref of refs) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref);
  }
  return out;
}
