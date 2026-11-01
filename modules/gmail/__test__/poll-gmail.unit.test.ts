// Gmail's poll of `Messages` and `Labelings` — what the taken filter reads,
// reading history to the end, and the cursor's resume point when a poll stops
// short. No network: the API client is faked, per label and per page.


import type { GmailApiClient } from '../api_client';

import {
  GmailApiError,
  type GmailHistoryAddition,
  type GmailLabelAddition,
  type GmailMessage,
  type GmailMessageRef,
  type GmailProfile,
} from '../api_client';
import { GmailPollSource } from '../poll';


function wireMessage(id: string, labelIds: string[] = ['INBOX']): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds,
    snippet: '',
    internalDate: String(Date.UTC(2026, 8, 22, 9, 0)),
    payload: {
      mimeType: 'text/plain',
      filename: '',
      headers: [
        { name: 'Subject', value: `About ${id}` },
        { name: 'From', value: 'founder@startup.example' },
      ],
      body: { size: 4, data: Buffer.from('Hi.', 'utf8').toString('base64url') },
    },
  };
}

interface HistoryPage {
  added: GmailHistoryAddition[];
  labelled?: GmailLabelAddition[];
  historyId?: string;
}

interface Calls {
  history: { startHistoryId: string; labelId?: string; pageToken?: string; types?: readonly string[] }[];
  list: { query?: string; maxResults?: number; includeSpamTrash?: boolean; pageToken?: string }[];
  get: string[];
  labels: number;
}

/** A fake whose history is PAGED per label: page n's token is `"<label>:<n>"`. */
function fakeClient(setup: {
  messages: GmailMessage[];
  history?: Record<string, HistoryPage[]>;
  historyExpired?: boolean;
  /** What every `messages.list` returns, whatever the query. */
  search?: GmailMessageRef[];
  /** A PAGED search instead: page n's token is `"search:<n>"`. */
  searchPages?: GmailMessageRef[][];
}) {
  const calls: Calls = { history: [], list: [], get: [], labels: 0 };
  const byId = new Map(setup.messages.map((m) => [m.id, m]));
  const client = {
    credentials: { mailbox: 'nemo@example.com', method: 'oauth' },
    async listLabels() {
      calls.labels += 1;
      return [
        { id: 'INBOX', name: 'INBOX' },
        { id: 'Label_deals', name: 'Deals' },
        { id: 'Label_other', name: 'Other' },
      ];
    },
    async getProfile(): Promise<GmailProfile> {
      return { emailAddress: 'nemo@example.com', historyId: '9000' };
    },
    async listHistory(input: { startHistoryId: string; labelId?: string; pageToken?: string; types?: readonly string[] }) {
      calls.history.push(input);
      if (setup.historyExpired) {
        throw new GmailApiError('history_expired', 404, 'history.list', 'Not Found');
      }
      const pages = setup.history?.[input.labelId ?? '*'] ?? [{ added: [], historyId: '5000' }];
      const index = input.pageToken === undefined ? 0 : Number(input.pageToken.split(':')[1]);
      const page = pages[index];
      const next = index + 1 < pages.length ? `${input.labelId}:${index + 1}` : undefined;
      return {
        added: page.added,
        labelled: page.labelled ?? [],
        ...(next !== undefined ? { nextPageToken: next } : {}),
        ...(page.historyId !== undefined ? { historyId: page.historyId } : {}),
      };
    },
    async listMessages(input: {
      query?: string;
      maxResults?: number;
      includeSpamTrash?: boolean;
      pageToken?: string;
    }) {
      calls.list.push(input);
      if (setup.searchPages === undefined) return { messages: setup.search ?? [] };
      const index = input.pageToken === undefined ? 0 : Number(input.pageToken.split(':')[1]);
      const next = index + 1 < setup.searchPages.length ? `search:${index + 1}` : undefined;
      return {
        messages: setup.searchPages[index],
        ...(next !== undefined ? { nextPageToken: next } : {}),
      };
    },
    async getMessage(id: string): Promise<GmailMessage> {
      calls.get.push(id);
      const message = byId.get(id);
      if (!message) throw new GmailApiError('other', 404, 'users.messages.get', 'gone');
      return message;
    },
  };
  return { client, calls };
}

/** The fake implements exactly the methods the poll calls. */
function asClient(client: unknown): GmailApiClient {
  return client as GmailApiClient;
}

function pollWith(setup: Parameters<typeof fakeClient>[0]) {
  const { client, calls } = fakeClient(setup);
  return { source: new GmailPollSource(async () => asClient(client)), calls };
}

const added = (id: string, historyId: string): GmailHistoryAddition => ({
  id,
  threadId: `thread-${id}`,
  historyId,
});

const MARK = { historyId: '4000', lastSeenAt: '2026-09-21T00:00:00.000Z' };

// A listen's taken filter, as the host hands it over.
const lit = (value: unknown) => ({ type: 'static', value });
const cmp = (field: string, op: string, value: unknown) => ({
  type: 'compare',
  op,
  left: { type: 'property', propertyTypeId: field, fieldOnly: true },
  right: Array.isArray(value) ? { type: 'list', elements: value.map(lit) } : lit(value),
});
const and = (...operands: unknown[]) => ({ type: 'logical', op: 'and', operands });
const or = (...operands: unknown[]) => ({ type: 'logical', op: 'or', operands });
const INBOX = cmp('Labels', 'contains', 'INBOX');

type Answer = Awaited<ReturnType<GmailPollSource['poll']>>;
const landed = (answer: Answer) => answer.arrivals.flatMap((a) => ('landing' in a ? [a] : []));
const ids = (answer: Answer) => landed(answer).map((a) => a.identity);

describe('a listen on Messages', () => {
  it('reads the history of the label it holds and delivers each message, the filter applied', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('m1')],
      history: { INBOX: [{ added: [added('m1', '4001')], historyId: '5000' }] },
    });
    const answer = await source.poll({ edge: 'Messages', filter: INBOX, cursor: MARK });

    expect(calls.history).toEqual([{ startHistoryId: '4000', labelId: 'INBOX', types: ['messageAdded'] }]);
    expect(answer.arrivals).toEqual([
      expect.objectContaining({
        edge: 'Messages',
        identity: 'm1',
        occurredAt: '2026-09-22T09:00:00.000Z',
        takenApplied: true,
        landing: expect.objectContaining({ recordId: 'm1', recordType: 'Message', fields: expect.objectContaining({ Subject: 'About m1', subject: 'About m1', Labels: ['INBOX'] }) }),
      }),
    ]);
    expect(answer.cursor).toMatchObject({ historyId: '5000' });
  });

  it('with no labels, reads the whole mailbox and searches Spam and Trash too', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('sent', ['SENT'])],
      history: { '*': [{ added: [added('sent', '4001')], historyId: '5000' }] },
      search: [{ id: 'sent' }],
    });
    const answer = await source.poll({ edge: 'Messages', filter: cmp('Query', 'eq', 'to:rita'), cursor: MARK });

    expect(calls.history[0]).not.toHaveProperty('labelId');
    expect(calls.list[0]).toEqual({ query: 'to:rita', maxResults: 100, includeSpamTrash: true });
    expect(ids(answer)).toEqual(['sent']);
    expect(landed(answer)[0]?.landing.fields).toMatchObject({ Query: 'to:rita' });
  });

  it('holds every label it CONTAINS: a user label by its name, a message lacking one is not delivered', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('both', ['INBOX', 'Label_deals']), wireMessage('inbox', ['INBOX'])],
      history: { INBOX: [{ added: [added('both', '4001'), added('inbox', '4002')], historyId: '5000' }] },
      search: [{ id: 'both' }, { id: 'inbox' }],
    });
    const answer = await source.poll({ edge: 'Messages', filter: and(INBOX, cmp('Labels', 'contains', 'Deals'), cmp('Query', 'eq', 'from:acme')), cursor: MARK });

    expect(calls.labels).toBe(1);
    expect(calls.list[0]?.query).toBe('label:INBOX label:Deals from:acme');
    expect(ids(answer)).toEqual(['both']);
  });

  it('hears mail carrying any label of an OR of CONTAINS, each user label by its name', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('deals', ['INBOX', 'Label_deals']), wireMessage('other', ['Label_other']), wireMessage('plain', ['INBOX'])],
      history: { '*': [{ added: [added('deals', '4001'), added('other', '4002'), added('plain', '4003')], historyId: '5000' }] },
      search: [{ id: 'deals' }, { id: 'other' }, { id: 'plain' }],
    });
    const either = or(cmp('Labels', 'contains', 'Deals'), cmp('Labels', 'contains', 'Other'));
    const answer = await source.poll({ edge: 'Messages', filter: and(either, cmp('Query', 'eq', 'from:acme')), cursor: MARK });

    expect(calls.history[0]).not.toHaveProperty('labelId');
    expect(calls.list[0]).toEqual({ query: '{label:Deals label:Other} from:acme', maxResults: 100 });
    expect(ids(answer)).toEqual(['deals', 'other']);
    expect(answer.arrivals.every((a) => 'takenApplied' in a && a.takenApplied === true)).toBe(true);
  });

  it('applies the rest of the filter over the message it fetched', async () => {
    const { source } = pollWith({
      messages: [wireMessage('invoice'), wireMessage('hello')],
      history: { INBOX: [{ added: [added('invoice', '4001'), added('hello', '4002')], historyId: '5000' }] },
    });
    const answer = await source.poll({ edge: 'Messages', filter: and(INBOX, cmp('Subject', 'contains', 'invoice')), cursor: MARK });
    expect(ids(answer)).toEqual(['invoice']);
  });

  it('leaves the whole of a filter it cannot read to the host', async () => {
    const { source } = pollWith({
      messages: [wireMessage('m1')],
      history: { '*': [{ added: [added('m1', '4001')], historyId: '5000' }] },
    });
    const answer = await source.poll({ edge: 'Messages', filter: or(INBOX, cmp('Subject', 'contains', 'SPAM')), cursor: MARK });
    expect(ids(answer)).toEqual(['m1']);
    expect(answer.arrivals[0]).not.toHaveProperty('takenApplied');
  });

  it('sets the mark on its first poll and delivers nothing', async () => {
    const { source, calls } = pollWith({ messages: [] });
    const answer = await source.poll({ edge: 'Messages', filter: INBOX });
    expect(answer.arrivals).toEqual([]);
    expect(answer.cursor).toMatchObject({ historyId: '9000' });
    expect(calls.history).toEqual([]);
  });

  it('refuses an edge it does not have, by name', async () => {
    const { source } = pollWith({ messages: [] });
    await expect(source.poll({ edge: 'Threads', cursor: MARK })).rejects.toThrow('@lf/gmail: no edge Threads to poll (its listenable edges are Messages and Labelings)');
  });
});

describe('reading history to the end', () => {
  it('follows every page of a label', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('p1'), wireMessage('p2'), wireMessage('p3')],
      history: {
        INBOX: [
          { added: [added('p1', '4001')] },
          { added: [added('p2', '4002')] },
          { added: [added('p3', '4003')], historyId: '5000' },
        ],
      },
    });
    const answer = await source.poll({ edge: 'Messages', filter: INBOX, cursor: MARK });

    expect(calls.history.map((c) => c.pageToken)).toEqual([undefined, 'INBOX:1', 'INBOX:2']);
    expect(ids(answer).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(answer.cursor).toMatchObject({ historyId: '5000' });
  });

  it('stops at a poll’s worth and marks just before the first arrival it left', async () => {
    const first = Array.from({ length: 100 }, (_, i) => added(`a${i}`, String(4001 + i)));
    const second = Array.from({ length: 5 }, (_, i) => added(`b${i}`, String(4101 + i)));
    const { source, calls } = pollWith({
      messages: [...first, ...second].map((ref) => wireMessage(ref.id)),
      history: { INBOX: [{ added: first }, { added: second }, { added: [], historyId: '5000' }] },
    });
    const answer = await source.poll({ edge: 'Messages', filter: INBOX, cursor: MARK });

    // One page was a poll's worth — the next page stays in Gmail's history.
    expect(calls.history).toHaveLength(1);
    expect(answer.arrivals).toHaveLength(100);
    expect(answer.cursor).toMatchObject({ historyId: '4100' });
  });

  it('caps the union across the labels a labeling listen names and resumes from the first change not taken', async () => {
    const labelled = (prefix: string, label: string, start: number) =>
      Array.from({ length: 60 }, (_, i) => ({ id: `${prefix}${i}`, threadId: 't', historyId: String(start + 2 * i), label }));
    const deals = labelled('d', 'Label_deals', 4001);
    const other = labelled('o', 'Label_other', 4002);
    const { source } = pollWith({
      messages: [...deals, ...other].map((ref) => wireMessage(ref.id)),
      history: {
        Label_deals: [{ added: [], labelled: deals, historyId: '5000' }],
        Label_other: [{ added: [], labelled: other, historyId: '5000' }],
      },
    });
    const answer = await source.poll({ edge: 'Labelings', filter: cmp('Label', 'in', ['Deals', 'Other']), cursor: MARK });

    // Interleaved by history id, 4001…4100 are the hundred taken.
    expect(answer.arrivals).toHaveLength(100);
    expect(answer.cursor).toMatchObject({ historyId: '4100' });
  });
});

describe('an expired change marker', () => {
  it('resyncs messages by a search from the last look, over the labels held', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('pitch', ['INBOX'])],
      historyExpired: true,
      search: [{ id: 'pitch', threadId: 't' }],
    });
    const answer = await source.poll({ edge: 'Messages', filter: and(INBOX, cmp('Query', 'eq', '-from:project-a.vc')), cursor: MARK });

    const since = Date.parse(MARK.lastSeenAt) / 1000;
    expect(calls.list[0]).toEqual({ query: `label:INBOX after:${since} -from:project-a.vc`, maxResults: 100 });
    expect(ids(answer)).toEqual(['pitch']);
    expect(answer.cursor).toMatchObject({ historyId: '9000' });
  });

  it('never replays label additions: the resync skips them and marks from now', async () => {
    const { source, calls } = pollWith({ messages: [wireMessage('m1')], historyExpired: true });
    const answer = await source.poll({ edge: 'Labelings', filter: cmp('Label', 'eq', 'Deals'), cursor: MARK });
    expect(answer.arrivals).toEqual([]);
    expect(calls.list).toEqual([]);
    expect(answer.cursor).toMatchObject({ historyId: '9000' });
  });
});

describe('an arrival the search has not caught up on', () => {
  const T0 = Date.UTC(2026, 8, 28, 12, 0);
  let clock = T0;
  beforeEach(() => {
    clock = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => jest.restoreAllMocks());

  const QUERY = and(INBOX, cmp('Query', 'eq', '-from:project-a.vc'));

  it('is carried as pending with the time it was first seen, not dropped', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('pitch')],
      history: { INBOX: [{ added: [added('pitch', '4001')], historyId: '5000' }] },
      search: [],
    });
    const answer = await source.poll({ edge: 'Messages', filter: QUERY, cursor: MARK });

    expect(answer.arrivals).toEqual([]);
    expect(calls.get).toEqual([]);
    expect(answer.cursor).toMatchObject({ historyId: '5000', pending: [{ id: 'pitch', firstSeenAt: new Date(T0).toISOString() }] });
  });

  it('is delivered on a later poll once the search admits it', async () => {
    const pending = [{ id: 'pitch', firstSeenAt: new Date(T0).toISOString() }];
    clock = T0 + 2 * 60 * 1000;
    const { source, calls } = pollWith({ messages: [wireMessage('pitch')], search: [{ id: 'pitch', threadId: 't' }] });
    const answer = await source.poll({ edge: 'Messages', filter: QUERY, cursor: { ...MARK, pending } });

    expect(ids(answer)).toEqual(['pitch']);
    expect(calls.get).toEqual(['pitch']);
    expect(answer.cursor).not.toHaveProperty('pending');
  });

  it('keeps its first-seen time while it waits', async () => {
    const firstSeenAt = new Date(T0).toISOString();
    clock = T0 + 5 * 60 * 1000;
    const { source } = pollWith({ messages: [], search: [] });
    const answer = await source.poll({ edge: 'Messages', filter: QUERY, cursor: { ...MARK, pending: [{ id: 'pitch', firstSeenAt }] } });
    expect(answer.cursor).toMatchObject({ pending: [{ id: 'pitch', firstSeenAt }] });
  });

  it('is given up once the grace window has passed — the query excludes it', async () => {
    clock = T0 + 15 * 60 * 1000;
    const { source, calls } = pollWith({ messages: [], search: [] });
    const answer = await source.poll({ edge: 'Messages', filter: QUERY, cursor: { ...MARK, pending: [{ id: 'internal', firstSeenAt: new Date(T0).toISOString() }] } });
    expect(calls.list).toHaveLength(1);
    expect(answer.arrivals).toEqual([]);
    expect(answer.cursor).not.toHaveProperty('pending');
  });

  it('reads further search pages for an id the first page did not hold', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('m1')],
      history: { INBOX: [{ added: [added('m1', '4001')], historyId: '5000' }] },
      searchPages: [[{ id: 'newer', threadId: 't' }], [{ id: 'm1', threadId: 't' }], [{ id: 'x' }]],
    });
    const answer = await source.poll({ edge: 'Messages', filter: and(INBOX, cmp('Query', 'eq', 'from:acme.com')), cursor: MARK });

    expect(calls.list.map((c) => c.pageToken)).toEqual([undefined, 'search:1']);
    expect(ids(answer)).toEqual(['m1']);
  });

  it('never holds anything pending when the listen has no query', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('m1')],
      history: { INBOX: [{ added: [added('m1', '4001')], historyId: '5000' }] },
    });
    const answer = await source.poll({ edge: 'Messages', filter: INBOX, cursor: MARK });
    expect(calls.list).toEqual([]);
    expect(answer.cursor).not.toHaveProperty('pending');
  });

  it('reads a cursor written before pending existed, and skips a malformed entry', async () => {
    const { source } = pollWith({ messages: [], search: [] });
    const old = await source.poll({ edge: 'Messages', filter: QUERY, cursor: MARK });
    expect(old.cursor).toMatchObject({ historyId: '5000' });
    expect(old.cursor).not.toHaveProperty('pending');

    const odd = await source.poll({ edge: 'Messages', filter: QUERY, cursor: { ...MARK, pending: [{ id: 'ok', firstSeenAt: new Date(T0).toISOString() }, { id: 3 }, 'x'] } });
    expect(odd.cursor).toMatchObject({ pending: [{ id: 'ok' }] });
  });
});

describe('a listen on Labelings', () => {
  const labelling = (id: string, label: string, historyId: string): GmailLabelAddition => ({ id, threadId: `thread-${id}`, historyId, label });

  it('hears each label added, with its type and the message’s fields, about the message', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('m1', ['INBOX', 'Label_deals'])],
      history: { Label_deals: [{ added: [], labelled: [labelling('m1', 'Label_deals', '4001')], historyId: '5000' }] },
    });
    const answer = await source.poll({ edge: 'Labelings', filter: cmp('Label', 'eq', 'Deals'), cursor: MARK });

    expect(calls.history).toEqual([{ startHistoryId: '4000', labelId: 'Label_deals', types: ['labelAdded'] }]);
    expect(answer.arrivals).toEqual([
      expect.objectContaining({
        edge: 'Labelings',
        identity: 'm1:Label_deals:4001',
        about: { recordType: 'Message', externalId: 'm1' },
        takenApplied: true,
        landing: expect.objectContaining({
          recordType: 'Labeling',
          fields: expect.objectContaining({ Id: 'm1:Label_deals:4001', Label: 'Label_deals', 'Label Type': 'user', Subject: 'About m1', 'Message Id': 'm1' }),
        }),
      }),
    ]);
  });

  it('counts only the labels the listen names: another label added to the same message is not one', async () => {
    const { source } = pollWith({
      messages: [wireMessage('m1', ['INBOX', 'Label_deals', 'STARRED'])],
      history: { Label_deals: [{ added: [], labelled: [labelling('m1', 'STARRED', '4001'), labelling('m1', 'Label_deals', '4002')], historyId: '5000' }] },
    });
    const answer = await source.poll({ edge: 'Labelings', filter: cmp('Label', 'eq', 'Deals'), cursor: MARK });
    expect(ids(answer)).toEqual(['m1:Label_deals:4002']);
  });

  it('with no Label, reads the whole mailbox; Label Type == "user" keeps the mailbox’s own labels', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('m1', ['INBOX', 'STARRED', 'Label_deals'])],
      history: { '*': [{ added: [], labelled: [labelling('m1', 'STARRED', '4001'), labelling('m1', 'Label_deals', '4002')], historyId: '5000' }] },
    });
    const answer = await source.poll({ edge: 'Labelings', filter: cmp('Label Type', 'eq', 'user'), cursor: MARK });
    expect(calls.history[0]).toEqual({ startHistoryId: '4000', types: ['labelAdded'] });
    expect(ids(answer)).toEqual(['m1:Label_deals:4002']);
    // The STARRED addition is judged before its message is fetched.
    expect(calls.get).toEqual(['m1']);
  });

  it('hears a label removed and added again as a second labeling', async () => {
    const { source } = pollWith({
      messages: [wireMessage('m1', ['Label_deals'])],
      history: { Label_deals: [{ added: [], labelled: [labelling('m1', 'Label_deals', '4001'), labelling('m1', 'Label_deals', '4007')], historyId: '5000' }] },
    });
    const answer = await source.poll({ edge: 'Labelings', filter: cmp('Label', 'eq', 'Label_deals'), cursor: MARK });
    expect(ids(answer)).toEqual(['m1:Label_deals:4001', 'm1:Label_deals:4007']);
  });

  it('narrows by its Query, dropping a message the query does not admit; a deleted message is skipped', async () => {
    const { source } = pollWith({
      messages: [wireMessage('acme'), wireMessage('other')],
      history: { Label_deals: [{ added: [], labelled: [labelling('acme', 'Label_deals', '4001'), labelling('other', 'Label_deals', '4002'), labelling('gone', 'Label_deals', '4003')], historyId: '5000' }] },
      search: [{ id: 'acme' }, { id: 'gone' }],
    });
    const answer = await source.poll({ edge: 'Labelings', filter: and(cmp('Label', 'eq', 'Deals'), cmp('Query', 'eq', 'from:acme')), cursor: MARK });
    expect(ids(answer)).toEqual(['acme:Label_deals:4001']);
    expect(landed(answer)[0]?.landing.fields).toMatchObject({ Query: 'from:acme' });
  });

  it('reads only label additions: a message arriving is not a labeling', async () => {
    const { source, calls } = pollWith({
      messages: [wireMessage('m1')],
      history: { '*': [{ added: [added('m1', '4001')], historyId: '5000' }] },
    });
    const answer = await source.poll({ edge: 'Labelings', cursor: MARK });
    expect(calls.history[0]?.types).toEqual(['labelAdded']);
    expect(answer.arrivals).toEqual([]);
  });

  it('fails the poll on a label the mailbox does not have, naming the ones it does', async () => {
    const { source } = pollWith({ messages: [] });
    await expect(source.poll({ edge: 'Labelings', filter: cmp('Label', 'eq', 'Dealz') })).rejects.toThrow(
      "a Gmail listen names the label 'Dealz', which nemo@example.com does not have — its labels are Deals, Other (or a system label such as INBOX)",
    );
  });
});
