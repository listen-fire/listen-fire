// The end state an automation leaves in the fake channels, as flat rows, and the
// judgement of a fixture's assertions against the change one event caused.
//
// Every system is read into the same shape — a collection of rows, each a map
// of field → string values — so an assertion is written once ("a company named
// Acme AI was created") whatever the system stores underneath. Reading is the
// only I/O here; flattening, diffing and judging are pure and unit-tested.

import { isDeepStrictEqual } from 'node:util';

import type { Assertion, Count, Fixture, Matcher } from './task';

interface Row {
  id: string;
  fields: Record<string, string[]>;
}

/** Collection name ("attio/companies") → its rows. */
type Snapshot = Record<string, Row[]>;

interface CollectionDelta {
  created: Row[];
  updated: Row[];
  deleted: Row[];
}

type Delta = Record<string, CollectionDelta>;

interface AssertionResult {
  label: string;
  pass: boolean;
  detail: string;
}

interface FixtureVerdict {
  pass: boolean;
  results: AssertionResult[];
}

// ── Flattening ─────────────────────────────────────────────────────────────

/** The keys Attio's typed value objects carry their scalar under, most specific first. */
const ATTIO_VALUE_KEYS = [
  'value',
  'domain',
  'email_address',
  'full_name',
  'target_record_id',
  'original_phone_number',
] as const;

function attioScalar(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  for (const key of ATTIO_VALUE_KEYS) {
    const v = record[key];
    if (v != null && typeof v !== 'object') return String(v);
  }
  for (const nested of ['option', 'status']) {
    const inner = record[nested];
    if (inner && typeof inner === 'object' && typeof (inner as { title?: unknown }).title === 'string') {
      return (inner as { title: string }).title;
    }
  }
  return JSON.stringify(value);
}

/** One stored Attio record → a row keyed by attribute slug. */
function flattenAttioRecord(stored: { id: string; values?: Record<string, unknown> }): Row {
  const fields: Record<string, string[]> = {};
  for (const [slug, raw] of Object.entries(stored.values ?? {})) {
    const items = Array.isArray(raw) ? raw : [raw];
    fields[slug] = items.map(attioScalar).filter((s): s is string => s !== null && s !== '');
  }
  return { id: stored.id, fields };
}

/** A stored Slack message → a row whose `channel` is the channel's name when known. */
function flattenSlackMessage(
  stored: Record<string, unknown> & { id: string },
  channelNames: Map<string, string>,
): Row {
  const channel = String(stored.channel ?? '');
  const text = typeof stored.text === 'string' ? stored.text : '';
  const blocks = stored.blocks == null ? '' : JSON.stringify(stored.blocks);
  return {
    id: stored.id,
    fields: {
      channel: [channelNames.get(channel) ?? channel.replace(/^#/, '')],
      text: [text, blocks].filter(Boolean),
      thread_ts: stored.thread_ts ? [String(stored.thread_ts)] : [],
    },
  };
}

interface OutboxMessage {
  id: string;
  recipients?: Array<{ email?: string } | string>;
  subject?: string;
  data?: string;
}

function flattenOutboxMessage(stored: OutboxMessage): Row {
  const to = (stored.recipients ?? []).map((r) => (typeof r === 'string' ? r : (r.email ?? '')));
  return {
    id: String(stored.id),
    fields: { to: to.filter(Boolean), subject: [stored.subject ?? ''], body: [stored.data ?? ''] },
  };
}

// ── Reading ────────────────────────────────────────────────────────────────

function attioRecordId(id: unknown): string {
  if (id && typeof id === 'object' && 'record_id' in id) return String((id as { record_id: unknown }).record_id);
  return String(id);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Everything an eval task can assert on, read from the fake channels' admin
 * surface (the same stores `pnpm dev:inspect` reads).
 */
async function readSnapshot(fakeChannelsUrl: string): Promise<Snapshot> {
  const snapshot: Snapshot = {};

  // The admin dump spreads each record over its store id, so `id` is the
  // record's own Attio id object — the store id lives on as its record_id.
  const attio = await getJson<Record<string, Array<Record<string, unknown>>>>(
    `${fakeChannelsUrl}/admin/attio/state`,
  );
  for (const [entityType, rows] of Object.entries(attio)) {
    if (!entityType.startsWith('record:')) continue;
    snapshot[`attio/${entityType.slice('record:'.length)}`] = rows.map((r) =>
      flattenAttioRecord({ id: attioRecordId(r.id), values: r.values as Record<string, unknown> | undefined }),
    );
  }

  const slack = await getJson<Record<string, Array<Record<string, unknown> & { id: string }>>>(
    `${fakeChannelsUrl}/admin/slack/state`,
  );
  const channelNames = new Map<string, string>(
    (slack.channel ?? []).map((c) => [String(c.id), String(c.name)]),
  );
  snapshot['slack/messages'] = (slack.message ?? []).map((m) => flattenSlackMessage(m, channelNames));

  const outbox = await getJson<{ data: OutboxMessage[] }>(`${fakeChannelsUrl}/email/outbox`);
  snapshot['email/outbox'] = outbox.data.map(flattenOutboxMessage);

  return snapshot;
}

// ── Diffing ────────────────────────────────────────────────────────────────

function diffSnapshots(before: Snapshot, after: Snapshot): Delta {
  const delta: Delta = {};
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of names) {
    const was = new Map((before[name] ?? []).map((r) => [r.id, r]));
    const now = new Map((after[name] ?? []).map((r) => [r.id, r]));
    const created = [...now.values()].filter((r) => !was.has(r.id));
    const deleted = [...was.values()].filter((r) => !now.has(r.id));
    const updated = [...now.values()].filter((r) => {
      const prior = was.get(r.id);
      return prior !== undefined && !isDeepStrictEqual(prior.fields, r.fields);
    });
    if (created.length + updated.length + deleted.length > 0) {
      delta[name] = { created, updated, deleted };
    }
  }
  return delta;
}

// ── Judging ────────────────────────────────────────────────────────────────

function matchesValue(matcher: Matcher, values: string[]): boolean {
  if (typeof matcher === 'string') {
    const want = matcher.trim().toLowerCase();
    return values.some((v) => v.trim().toLowerCase() === want);
  }
  if (matcher instanceof RegExp) {
    return values.some((v) => {
      matcher.lastIndex = 0;
      return matcher.test(v);
    });
  }
  const has = values.some((v) => v.trim() !== '');
  return matcher.present ? has : !has;
}

function rowMatches(row: Row, where: Record<string, Matcher> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([field, matcher]) => matchesValue(matcher, row.fields[field] ?? []));
}

function countSatisfied(count: Count, n: number): boolean {
  if (typeof count === 'number') return n === count;
  return (count.min === undefined || n >= count.min) && (count.max === undefined || n <= count.max);
}

function describeCount(count: Count): string {
  if (typeof count === 'number') return `exactly ${count}`;
  if (count.min !== undefined && count.max !== undefined) return `${count.min}–${count.max}`;
  if (count.min !== undefined) return `at least ${count.min}`;
  return `at most ${count.max ?? 0}`;
}

function describeWhere(where: Record<string, Matcher> | undefined): string {
  if (!where) return '';
  const parts = Object.entries(where).map(([field, m]) => {
    if (typeof m === 'string') return `${field}="${m}"`;
    if (m instanceof RegExp) return `${field}~${m.source}`;
    return `${field} ${m.present ? 'set' : 'empty'}`;
  });
  return ` where ${parts.join(', ')}`;
}

function defaultLabel(assertion: Assertion): string {
  switch (assertion.kind) {
    case 'untouched':
      return `${assertion.collection} untouched`;
    case 'created':
    case 'updated':
    case 'present':
      return `${describeCount(assertion.count)} ${assertion.kind} in ${assertion.collection}${describeWhere(assertion.where)}`;
  }
}

function evaluateAssertion(
  assertion: Assertion,
  delta: Delta,
  after: Snapshot,
): AssertionResult {
  const label = assertion.label ?? defaultLabel(assertion);
  const changes = delta[assertion.collection];
  switch (assertion.kind) {
    case 'untouched': {
      const n = changes ? changes.created.length + changes.updated.length + changes.deleted.length : 0;
      return { label, pass: n === 0, detail: n === 0 ? 'no change' : `${n} row(s) changed` };
    }
    case 'created':
    case 'updated':
    case 'present': {
      const pool =
        assertion.kind === 'present'
          ? (after[assertion.collection] ?? [])
          : (changes?.[assertion.kind] ?? []);
      const n = pool.filter((r) => rowMatches(r, assertion.where)).length;
      return {
        label,
        pass: countSatisfied(assertion.count, n),
        detail: `matched ${n} of ${pool.length} ${assertion.kind === 'present' ? 'rows' : `${assertion.kind} rows`}`,
      };
    }
  }
}

/** The collections a fixture's assertions speak about — the ones it may change. */
function collectionsNamed(fixture: Fixture): Set<string> {
  const named = new Set(fixture.mayAlsoTouch ?? []);
  for (const a of fixture.assertions) {
    if (a.kind !== 'untouched') named.add(a.collection);
  }
  return named;
}

/**
 * A fixture passes when every assertion holds and nothing outside the
 * collections it names changed — an automation that also scribbles somewhere
 * unexpected fails, however right the rest is.
 */
function judgeFixture(fixture: Fixture, before: Snapshot, after: Snapshot): FixtureVerdict {
  const delta = diffSnapshots(before, after);
  const results = fixture.assertions.map((a) => evaluateAssertion(a, delta, after));
  const allowed = collectionsNamed(fixture);
  for (const [collection, change] of Object.entries(delta)) {
    if (allowed.has(collection)) continue;
    results.push({
      label: `nothing else touched: ${collection}`,
      pass: false,
      detail: `${change.created.length} created, ${change.updated.length} updated, ${change.deleted.length} deleted`,
    });
  }
  return { pass: results.every((r) => r.pass), results };
}

export {
  diffSnapshots,
  evaluateAssertion,
  flattenAttioRecord,
  flattenOutboxMessage,
  flattenSlackMessage,
  judgeFixture,
  readSnapshot,
};
export type { AssertionResult, Delta, FixtureVerdict, Row, Snapshot };
