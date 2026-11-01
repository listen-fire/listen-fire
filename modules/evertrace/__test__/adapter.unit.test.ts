// Evertrace adapter + PollSource — the entry surface, every describe, the edge
// walks, the WHERE pushdown, the write surface (including the not-found
// contract) and the poll's checkpoint behaviour. No network: the API client is
// faked.

import type { MutationContext } from 'movement-engine/public/adapter';
import type { Expression } from 'engine-contracts/expression/expression';

import { updateRecordSucceeded } from 'movement-engine/public/adapter';
import {
  ADAPTER_META_TYPE_ID,
  makeMetaPosition,
  makeStablePosition,
  makeUnstablePosition,
  positionData,
} from 'movement-engine/public/catalog';
import {
  EvertraceApiError,
  type EvertraceApiClient,
  type EvertraceList,
  type EvertraceListEntry,
  type EvertraceSearch,
  type EvertraceSearchFilterRow,
  type EvertraceSignal,
  type EvertraceSignalFilter,
} from '../api_client';
import { EvertraceAdapter, EVERTRACE_MANIFEST } from '../index';
import { pollEvertrace } from '../poll';
import { signalFilterFromWhere, lookupSearchTerm } from '../filter';
import { instanceSchemaFromDescriptors } from 'movement-engine/public/catalog';
import {
  EVERTRACE_COMPANY_TYPE_ID,
  EVERTRACE_EDUCATION_TYPE_ID,
  EVERTRACE_EXPERIENCE_TYPE_ID,
  EVERTRACE_LIST_ENTRY_TYPE_ID,
  EVERTRACE_LIST_TYPE_ID,
  EVERTRACE_SCHOOL_TYPE_ID,
  EVERTRACE_SEARCH_TYPE_ID,
  EVERTRACE_SIGNAL_TYPE_ID,
  EVERTRACE_WORKSPACE_TYPE_ID,
  decodeListEntryId,
  encodeListEntryId,
} from '../types';

/** What the module's host gives it to log with. */
const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

/** An adapter that is never asked for a client (the reads here are off inline
 *  position data), and one over a fake client. */
const withoutClient = () =>
  new EvertraceAdapter(async () => {
    throw new Error('no client in this test');
  });

const MUTATION: MutationContext = {} as MutationContext;

const DISCOVERED_AT = Date.UTC(2026, 7, 15, 9, 0, 0);
const CREATED_AT = Date.UTC(2026, 7, 16, 9, 0, 0);

function signal(over: Partial<EvertraceSignal> = {}): EvertraceSignal {
  return {
    id: 'sig-1',
    score: 8,
    source: 'linkedin',
    firstName: 'Ada',
    lastName: 'Byron',
    imageUrl: null,
    nationality: 'British',
    description: 'Started a new company',
    city: 'London',
    country: 'United Kingdom',
    gender: 'woman',
    githubSlug: null,
    linkedinIdIm: null,
    linkedinIdStr: 'ada-byron',
    signalHash: 'hash-1',
    profileAccuracy: 'high',
    age: '35',
    discoveredAt: DISCOVERED_AT,
    twitterId: null,
    email: 'ada@example.com',
    stealthSign: null,
    stealthReason: null,
    summary: 'A long write-up.',
    createdAt: CREATED_AT,
    taggings: [
      { id: 't1', key: 'Serial Founder', namespace: 'profile', signalId: 'sig-1', createdAt: 1, updatedAt: 1 },
      { id: 't2', key: 'YC Alumni', namespace: 'profile', signalId: 'sig-1', createdAt: 1, updatedAt: 1 },
    ],
    experiences: [
      {
        id: 'exp-2', signalId: 'sig-1', title: 'Founder', companyName: 'Analytical',
        location: 'London', indexOrder: 1, startDate: '2026', endDate: null,
        createdAt: 1, updatedAt: 1,
        entity: {
          id: 'exe_1', source: null, name: 'Analytical', websiteUrl: 'https://analytical.example',
          customerSegment: 'B2B', sourceUrl: null, logoUrl: null, employeeCount: 12,
          createdAt: 1, updatedAt: 1,
        },
      },
      {
        id: 'exp-1', signalId: 'sig-1', title: 'Engineer', companyName: 'Difference',
        location: 'London', indexOrder: 0, startDate: '2020', endDate: '2026',
        createdAt: 1, updatedAt: 1, entity: null,
      },
    ],
    educations: [
      {
        id: 'edu-1', signalId: 'sig-1', degree: 'MSc', schoolName: 'Somewhere',
        indexOrder: 0, startDate: '2016', endDate: '2018', createdAt: 1, updatedAt: 1,
        entity: { id: 'ede_1', name: 'Somewhere', sourceUrl: null, logoUrl: null, studentCount: 900, createdAt: 1, updatedAt: 1 },
      },
    ],
    views: [],
    screenings: [{ id: 'scr-1', workspaceId: 'ws', createdBy: null, signalId: 'sig-1', createdAt: 1, updatedAt: 1 }],
    region: { id: 'r1', signalId: 'sig-1', name: 'Europe', createdAt: 1, updatedAt: 1 },
    listPresence: true,
    ...over,
  };
}

function search(over: Partial<EvertraceSearch> = {}): EvertraceSearch {
  return {
    id: 'sea-1', workspaceId: 'ws', emoji: '🔭', title: 'Stealth in Europe',
    createdBy: null, updatedBy: null, createdAt: CREATED_AT, updatedAt: CREATED_AT,
    visitedAt: CREATED_AT, visitedBy: null, orderIndex: 'a', filters: [], sharees: [],
    ...over,
  };
}

function filterRow(over: Partial<EvertraceSearchFilterRow> & { key: string }): EvertraceSearchFilterRow {
  return {
    id: `sfr-${over.key}`, searchId: 'sea-1', operator: 'in', value: '',
    workspaceId: 'ws', createdAt: CREATED_AT, updatedAt: CREATED_AT,
    ...over,
  };
}

/** A search row as a workspace that answers `GET /searches` without `filters`
 *  would carry it — the poll then fetches the search itself. */
function searchWithoutRows(): EvertraceSearch {
  const { filters: _filters, ...rest } = search({ id: 'sea-fetch' });
  return rest;
}

function list(over: Partial<EvertraceList> = {}): EvertraceList {
  return {
    id: 'lst-1', workspaceId: 'ws', createdBy: null, name: 'Watchlist',
    createdAt: CREATED_AT, updatedAt: CREATED_AT, entriesCount: 3,
    ...over,
  };
}

function listEntry(over: Partial<EvertraceListEntry> = {}): EvertraceListEntry {
  return {
    id: 'ent-1', workspaceId: 'ws', listId: 'lst-1', signalId: 'sig-1',
    addedBy: null, createdAt: CREATED_AT, updatedAt: CREATED_AT,
    ...over,
  };
}

/** A page-one-only fake: every listing answers with the rows it was given, so a
 *  short page ends the walk on the first request. */
function fakeClient(over: Partial<Record<keyof EvertraceApiClient, unknown>> = {}): EvertraceApiClient {
  return {
    listSignals: async () => ({ data: [signal()], meta: { page: 1, limit: 100 } }),
    getSignal: async () => signal(),
    listSignalEntries: async () => [listEntry()],
    listSearches: async () => [search()],
    getSearch: async () => search(),
    listSearchSignals: async () => ({ data: [signal()], meta: { page: 1, limit: 100 } }),
    listLists: async () => [list()],
    getList: async () => list(),
    listListEntries: async () => ({ data: [listEntry()], meta: { page: 1, limit: 100 } }),
    listCompanies: async () => ({
      data: [{ id: 'exe_1', source: null, name: 'Analytical', websiteUrl: null, customerSegment: null, sourceUrl: null, logoUrl: null, employeeCount: 12, createdAt: 1, updatedAt: 1 }],
      meta: { page: 1, limit: 100 },
    }),
    listEducations: async () => ({
      data: [{ id: 'ede_1', name: 'Somewhere', sourceUrl: null, logoUrl: null, studentCount: 900, createdAt: 1, updatedAt: 1 }],
      meta: { page: 1, limit: 100 },
    }),
    ...over,
  } as unknown as EvertraceApiClient;
}

const adapterWith = (client: EvertraceApiClient) => new EvertraceAdapter(async () => client);

// The engine's source-read wrapper restamps a position's recordType to the
// NATURAL type name before a field/edge read. Mirror that here.
const at = (recordType: string, recordId: string, data: unknown) =>
  makeStablePosition({ adapterType: 'evertrace', recordType, recordId, data });

// ── entry surface ───────────────────────────────────────────────────────────

describe('EvertraceAdapter entry surface', () => {
  const adapter = withoutClient();

  it('publishes one entry per type, with a root collection only where the root can enumerate', async () => {
    const entries = await adapter.listEntryPoints();
    expect(
      entries.map((e) => ({
        typeId: e.typeId,
        readable: e.readable,
        writable: e.writable,
        listenable: e.listenable ?? false,
        collection: e.collectionName ?? null,
      })),
    ).toEqual([
      { typeId: EVERTRACE_SIGNAL_TYPE_ID, readable: true, writable: true, listenable: true, collection: 'Signals' },
      { typeId: EVERTRACE_SEARCH_TYPE_ID, readable: true, writable: true, listenable: false, collection: 'Searches' },
      { typeId: EVERTRACE_LIST_TYPE_ID, readable: true, writable: true, listenable: false, collection: 'Lists' },
      { typeId: EVERTRACE_COMPANY_TYPE_ID, readable: true, writable: false, listenable: false, collection: 'Companies' },
      { typeId: EVERTRACE_SCHOOL_TYPE_ID, readable: true, writable: false, listenable: false, collection: 'Schools' },
      { typeId: EVERTRACE_EXPERIENCE_TYPE_ID, readable: false, writable: false, listenable: false, collection: null },
      { typeId: EVERTRACE_EDUCATION_TYPE_ID, readable: false, writable: false, listenable: false, collection: null },
      { typeId: EVERTRACE_LIST_ENTRY_TYPE_ID, readable: false, writable: false, listenable: true, collection: 'List Entries' },
    ]);
  });

  it('declares Signals and List Entries as polled, cursored edges and nothing else as listenable', async () => {
    const entries = await adapter.listEntryPoints();
    expect(entries.filter((e) => e.listenable).map((e) => ({
      collection: e.collectionName,
      delivery: e.delivery,
      pollEverySeconds: e.pollEverySeconds,
      cursor: e.cursor,
      filter: e.capability?.filter,
    }))).toEqual([
      { collection: 'Signals', delivery: 'polled', pollEverySeconds: 300, cursor: true, filter: 'native' },
      { collection: 'List Entries', delivery: 'polled', pollEverySeconds: 300, cursor: true, filter: 'native' },
    ]);
  });

  it('declares the poll trigger, the Evertrace credential and how a 0.12 listen becomes a traversal on the edge its event arrives on', () => {
    expect(EVERTRACE_MANIFEST.supportedTriggers).toEqual(['poll']);
    expect(EVERTRACE_MANIFEST.requiredCredentialType).toBe('EVERTRACE');
    expect(EVERTRACE_MANIFEST.triggerKinds).toEqual(['EVERTRACE']);
    expect(EVERTRACE_MANIFEST.subscribableEvents).toBeUndefined();
    expect(EVERTRACE_MANIFEST.defaultSubscribedEvents).toBeUndefined();
    expect(EVERTRACE_MANIFEST.listenConfig).toBeUndefined();
    const signals = {
      path: ['Signals'],
      aliases: ['s'],
      paramFrom: 'Signal',
      keys: { search: { hop: 0, field: 'Saved Search', op: 'eq' } },
    };
    expect(EVERTRACE_MANIFEST.listenSettingsBecome).toEqual({
      ...signals,
      byEvent: {
        signal: signals,
        list_entry: {
          path: ['List Entries'],
          aliases: ['e'],
          paramFrom: 'List Entry',
          keys: { list: { hop: 0, field: 'List Name', op: 'eq' } },
        },
      },
    });
  });
});

// ── describe ────────────────────────────────────────────────────────────────

describe('EvertraceAdapter.describe', () => {
  const adapter = withoutClient();

  it('describes the workspace meta node with its root collections, Signals and List Entries listenable', async () => {
    for (const ref of [ADAPTER_META_TYPE_ID, EVERTRACE_WORKSPACE_TYPE_ID]) {
      const d = await adapter.describe(ref);
      expect(d?.typeId).toBe(EVERTRACE_WORKSPACE_TYPE_ID);
      expect(d?.references.map((r) => r.name)).toEqual([
        'Signals', 'Searches', 'Lists', 'List Entries', 'Companies', 'Schools',
      ]);
      // Only these two edges are listened to; only searches and lists are creatable there.
      expect(d?.references.filter((r) => r.listenable).map((r) => r.name)).toEqual([
        'Signals', 'List Entries',
      ]);
      expect(d?.references.filter((r) => r.writable).map((r) => r.name)).toEqual([
        'Searches', 'Lists',
      ]);
    }
  });

  it('describes a signal: the two writable facts, the computed name/tags, and three edges', async () => {
    const d = await adapter.describe('Signal');
    expect(d?.typeId).toBe(EVERTRACE_SIGNAL_TYPE_ID);
    expect(d?.fields.filter((f) => f.writable).map((f) => f.displayName)).toEqual([
      'Screened',
      'Viewed',
    ]);
    expect(d?.fields.map((f) => f.displayName)).toEqual(
      expect.arrayContaining(['Name', 'Tags', 'Score', 'Discovered At', 'In A List']),
    );
    expect(d?.references.map((r) => r.name)).toEqual([
      'Experiences', 'Educations', 'List Entries',
    ]);
    expect(d?.references.find((r) => r.name === 'List Entries')?.writable).toBe(true);

    // `Tags` offers both vocabularies as values an author can pick from — the
    // same sets the pushdown routes on.
    const tags = d?.fields.find((f) => f.displayName === 'Tags');
    expect(tags?.knownValues).toEqual(expect.arrayContaining(['New Company', 'YC Alumni']));
    expect(tags?.knownValues).toHaveLength(15);
  });

  it('describes the child and lookup types', async () => {
    const experience = await adapter.describe('Experience');
    expect(experience?.fields.map((f) => f.displayName)).toEqual([
      'Title', 'Company Name', 'Location', 'Start Date', 'End Date', 'Order',
    ]);
    expect(experience?.references.map((r) => r.name)).toEqual(['Company']);

    const education = await adapter.describe('Education');
    expect(education?.references.map((r) => r.name)).toEqual(['School']);

    const company = await adapter.describe('Company');
    expect(company?.fields.map((f) => f.displayName)).toEqual([
      'Name', 'Website', 'Customer Segment', 'Employee Count', 'Logo URL', 'Source URL',
    ]);
    expect(company?.references).toEqual([]);

    const school = await adapter.describe('School');
    expect(school?.fields.map((f) => f.displayName)).toEqual([
      'Name', 'Student Count', 'Logo URL', 'Source URL',
    ]);
  });

  it('describes searches, lists and the both-ends-required list entry', async () => {
    const searchType = await adapter.describe('Search');
    expect(searchType?.fields.filter((f) => f.writable).map((f) => f.displayName)).toEqual([
      'Title', 'Emoji', 'Filters',
    ]);
    expect(searchType?.references.map((r) => r.name)).toEqual(['Signals']);

    const listType = await adapter.describe('List');
    expect(listType?.references.find((r) => r.name === 'Entries')?.writable).toBe(true);

    const entryType = await adapter.describe('List Entry');
    expect(entryType?.references.map((r) => ({ name: r.name, required: r.required }))).toEqual([
      { name: 'Signal', required: true },
      { name: 'List', required: true },
    ]);
  });

  it('answers null for a type it does not own', async () => {
    expect(await adapter.describe('Nonexistent')).toBeNull();
  });

  it('walks from the root to a signal and on to its experiences', async () => {
    const root = await adapter.edgesFrom(makeMetaPosition('evertrace'));
    expect(root?.targetNodes?.['Signals']?.displayName).toBe('Signal');
    const signalHop = await adapter.edgesFrom(
      at('Signal', 'sig-1', signal()),
    );
    expect(signalHop?.descriptor.typeId).toBe(EVERTRACE_SIGNAL_TYPE_ID);
    expect(signalHop?.targetNodes?.['experiences']?.displayName).toBe('Experience');
  });
});

// ── field reads ─────────────────────────────────────────────────────────────

describe('EvertraceAdapter.getFieldValue', () => {
  const adapter = withoutClient();
  const position = () => at('Signal', 'sig-1', signal());

  it('reads a literal scalar by its natural name', async () => {
    expect(await adapter.getFieldValue({ position: position(), fieldId: 'City' })).toBe('London');
    expect(await adapter.getFieldValue({ position: position(), fieldId: 'Score' })).toBe(8);
  });

  it('composes the name Evertrace stores across two columns', async () => {
    expect(await adapter.getFieldValue({ position: position(), fieldId: 'Name' })).toBe('Ada Byron');
  });

  it('reads tags off the tagging rows and the region off its own object', async () => {
    expect(await adapter.getFieldValue({ position: position(), fieldId: 'Tags' })).toEqual([
      'Serial Founder',
      'YC Alumni',
    ]);
    expect(await adapter.getFieldValue({ position: position(), fieldId: 'Region' })).toBe('Europe');
  });

  it('derives Screened and Viewed from the rows Evertrace keeps for each', async () => {
    expect(await adapter.getFieldValue({ position: position(), fieldId: 'Screened' })).toBe(true);
    expect(await adapter.getFieldValue({ position: position(), fieldId: 'Viewed' })).toBe(false);
  });

  it('reads an epoch-millisecond timestamp back as an ISO instant', async () => {
    expect(await adapter.getFieldValue({ position: position(), fieldId: 'Discovered At' })).toBe(
      new Date(DISCOVERED_AT).toISOString(),
    );
    const entryPosition = at('List Entry', 'lst-1:ent-1', listEntry());
    expect(await adapter.getFieldValue({ position: entryPosition, fieldId: 'Added At' })).toBe(
      new Date(CREATED_AT).toISOString(),
    );
  });

  it('tolerates a trimmed signal, whose relation fields are simply absent', async () => {
    const trimmed = at('Signal', 'sig-1', {
      ...signal(),
      taggings: undefined,
      screenings: undefined,
      views: undefined,
      region: undefined,
    });
    expect(await adapter.getFieldValue({ position: trimmed, fieldId: 'Tags' })).toEqual([]);
    expect(await adapter.getFieldValue({ position: trimmed, fieldId: 'Screened' })).toBe(false);
    expect(await adapter.getFieldValue({ position: trimmed, fieldId: 'Region' })).toBeNull();
  });

  it('refuses a position minted by another adapter', async () => {
    await expect(
      adapter.getFieldValue({
        position: makeStablePosition({ adapterType: 'granola', recordType: 'Signal', recordId: 'x', data: {} }),
        fieldId: 'City',
      }),
    ).rejects.toThrow(/different adapter/);
  });
});

// ── traversal ───────────────────────────────────────────────────────────────

describe('EvertraceAdapter.getRelated — root collections', () => {
  const meta = makeMetaPosition('evertrace');

  it('lands Signals, Searches, Lists, Companies and Schools on their own types', async () => {
    const adapter = adapterWith(fakeClient());
    const cases: Array<[string, string]> = [
      ['Signals', 'Signal'],
      ['Searches', 'Search'],
      ['Lists', 'List'],
      ['Companies', 'Company'],
      ['Schools', 'School'],
    ];
    for (const [collection, recordType] of cases) {
      const related = await adapter.getRelated({
        position: meta,
        fieldId: collection,
        direction: 'outgoing',
      });
      expect(related).toHaveLength(1);
      expect(related[0].position.recordType).toBe(recordType);
    }
  });

  it('returns nothing for a collection the root does not publish', async () => {
    const adapter = adapterWith(fakeClient());
    expect(
      await adapter.getRelated({ position: meta, fieldId: 'Nonexistent', direction: 'outgoing' }),
    ).toEqual([]);
  });

  it('honours the hop LIMIT on an unpaged listing', async () => {
    const adapter = adapterWith(
      fakeClient({ listLists: async () => [list({ id: 'a' }), list({ id: 'b' }), list({ id: 'c' })] }),
    );
    const related = await adapter.getRelated({
      position: meta,
      fieldId: 'Lists',
      direction: 'outgoing',
      limit: 2,
    });
    expect(related.map((r) => r.position.identity)).toHaveLength(2);
  });

  // Evertrace's root listings take no sort, so an ORDER BY on one costs the
  // whole fetch — and the LIMIT stays with the engine that does the sorting.
  it('ignores the hop LIMIT on a root collection whenever an ORDER BY came with it', async () => {
    const pages = jest.fn(async (input: { page?: number }) =>
      input.page === 1
        ? { data: [signal({ id: 'a' }), signal({ id: 'b' })], meta: { page: 1, limit: 100 } }
        : { data: [], meta: { page: 2, limit: 100 } },
    );
    const adapter = adapterWith(fakeClient({ listSignals: pages }));
    const related = await adapter.getRelated({
      position: meta,
      fieldId: 'Signals',
      direction: 'outgoing',
      orderBy: { fieldId: 'Score', direction: 'desc' },
      limit: 1,
    });
    expect(pages.mock.calls[0]?.[0]).toMatchObject({ limit: 100 });
    expect(related).toHaveLength(2);
  });

  it('ignores the hop LIMIT on an unpaged root listing under an ORDER BY', async () => {
    const adapter = adapterWith(
      fakeClient({ listLists: async () => [list({ id: 'a' }), list({ id: 'b' }), list({ id: 'c' })] }),
    );
    const related = await adapter.getRelated({
      position: meta,
      fieldId: 'Lists',
      direction: 'outgoing',
      orderBy: { fieldId: 'Name', direction: 'asc' },
      limit: 2,
    });
    expect(related).toHaveLength(3);
  });

  it('ignores the hop LIMIT on a search’s Signals walk under an ORDER BY', async () => {
    const pages = jest.fn(async (_id: string, opts: { page?: number }) =>
      opts.page === 1
        ? { data: [signal({ id: 'a' }), signal({ id: 'b' })], meta: { page: 1, limit: 100 } }
        : { data: [], meta: { page: 2, limit: 100 } },
    );
    const adapter = adapterWith(fakeClient({ listSearchSignals: pages }));
    const related = await adapter.getRelated({
      position: at('Search', 'sea-1', search()),
      fieldId: 'Signals',
      direction: 'outgoing',
      orderBy: { fieldId: 'Score', direction: 'desc' },
      limit: 1,
    });
    expect(pages.mock.calls[0]?.[1]).toMatchObject({ limit: 100 });
    expect(related).toHaveLength(2);
  });

  it('stops paging a paged listing on a short page', async () => {
    const pages = jest.fn(async (input: { page?: number }) =>
      input.page === 1
        ? { data: [signal({ id: 'a' }), signal({ id: 'b' })], meta: { page: 1, limit: 100 } }
        : { data: [], meta: { page: 2, limit: 100 } },
    );
    const adapter = adapterWith(fakeClient({ listSignals: pages }));
    const related = await adapter.getRelated({
      position: meta,
      fieldId: 'Signals',
      direction: 'outgoing',
    });
    expect(related).toHaveLength(2);
    expect(pages).toHaveBeenCalledTimes(1);
  });
});

describe('EvertraceAdapter.getRelated — edges below the root', () => {
  it('orders a signal’s experiences and educations by their position on the profile', async () => {
    const adapter = adapterWith(fakeClient());
    const position = at('Signal', 'sig-1', signal());
    const experiences = await adapter.getRelated({
      position,
      fieldId: 'Experiences',
      direction: 'outgoing',
    });
    expect(experiences.map((r) => (positionData(r.position) as { id: string }).id)).toEqual([
      'exp-1',
      'exp-2',
    ]);
    expect(experiences[0].position.recordType).toBe('Experience');

    const educations = await adapter.getRelated({
      position,
      fieldId: 'Educations',
      direction: 'outgoing',
    });
    expect(educations[0].position.recordType).toBe('Education');
  });

  it('resolves an experience to its company and an education to its school, or to nothing', async () => {
    const adapter = adapterWith(fakeClient());
    const withEntity = makeUnstablePosition({
      adapterType: 'evertrace',
      recordType: 'Experience',
      data: signal().experiences![0],
    });
    const company = await adapter.getRelated({
      position: withEntity,
      fieldId: 'Company',
      direction: 'outgoing',
    });
    expect(company[0].position.recordType).toBe('Company');

    const withoutEntity = makeUnstablePosition({
      adapterType: 'evertrace',
      recordType: 'Experience',
      data: signal().experiences![1],
    });
    expect(
      await adapter.getRelated({ position: withoutEntity, fieldId: 'Company', direction: 'outgoing' }),
    ).toEqual([]);

    const education = makeUnstablePosition({
      adapterType: 'evertrace',
      recordType: 'Education',
      data: signal().educations![0],
    });
    const school = await adapter.getRelated({
      position: education,
      fieldId: 'School',
      direction: 'outgoing',
    });
    expect(school[0].position.recordType).toBe('School');
  });

  it('walks a signal’s memberships, a search’s signals, and a list’s entries', async () => {
    const adapter = adapterWith(fakeClient());
    const memberships = await adapter.getRelated({
      position: at('Signal', 'sig-1', signal()),
      fieldId: 'List Entries',
      direction: 'outgoing',
    });
    expect(memberships[0].position.recordType).toBe('List Entry');

    const searchSignals = await adapter.getRelated({
      position: at('Search', 'sea-1', search()),
      fieldId: 'Signals',
      direction: 'outgoing',
    });
    expect(searchSignals[0].position.recordType).toBe('Signal');

    const entries = await adapter.getRelated({
      position: at('List', 'lst-1', list()),
      fieldId: 'Entries',
      direction: 'outgoing',
    });
    expect(entries[0].position.recordType).toBe('List Entry');
  });

  it('runs a search’s Signals walk on the saved-search listing, not the signal listing', async () => {
    const listSearchSignals = jest.fn(async () => ({ data: [signal()], meta: { page: 1, limit: 100 } }));
    const listSignals = jest.fn();
    const adapter = adapterWith(fakeClient({ listSearchSignals, listSignals }));
    await adapter.getRelated({
      position: at('Search', 'sea-1', search()),
      fieldId: 'Signals',
      direction: 'outgoing',
    });
    expect(listSearchSignals).toHaveBeenCalledWith('sea-1', { page: 1, limit: 100 });
    expect(listSignals).not.toHaveBeenCalled();
  });

  it('addresses a list entry by its list and its own id together', async () => {
    const adapter = adapterWith(fakeClient());
    const entries = await adapter.getRelated({
      position: at('List', 'lst-1', list()),
      fieldId: 'Entries',
      direction: 'outgoing',
    });
    const identity = entries[0].position.identity;
    expect(identity.kind === 'stable' && identity.recordId).toBe(
      encodeListEntryId({ listId: 'lst-1', entryId: 'ent-1' }),
    );
    expect(decodeListEntryId('lst-1:ent-1')).toEqual({ listId: 'lst-1', entryId: 'ent-1' });
    expect(decodeListEntryId('no-separator')).toBeUndefined();
  });

  it('follows a list entry to both its ends, fetching the signal when the row does not carry it', async () => {
    const getSignal = jest.fn(async () => signal());
    const adapter = adapterWith(fakeClient({ getSignal }));
    const position = at('List Entry', 'lst-1:ent-1', listEntry());
    const toSignal = await adapter.getRelated({
      position,
      fieldId: 'Signal',
      direction: 'outgoing',
    });
    expect(toSignal[0].position.recordType).toBe('Signal');
    expect(getSignal).toHaveBeenCalledWith('sig-1');

    const toList = await adapter.getRelated({ position, fieldId: 'List', direction: 'outgoing' });
    expect(toList[0].position.recordType).toBe('List');
  });

  it('reads the expanded signal off an entry rather than fetching it again', async () => {
    const getSignal = jest.fn(async () => signal());
    const adapter = adapterWith(fakeClient({ getSignal }));
    const related = await adapter.getRelated({
      position: at('List Entry', 'lst-1:ent-1', listEntry({ signal: signal() })),
      fieldId: 'Signal',
      direction: 'outgoing',
    });
    expect(related).toHaveLength(1);
    expect(getSignal).not.toHaveBeenCalled();
  });

  it('reads nothing on an incoming traversal (this adapter only walks outward)', async () => {
    const adapter = adapterWith(fakeClient());
    expect(
      await adapter.getRelated({
        position: at('Signal', 'sig-1', signal()),
        fieldId: 'Experiences',
        direction: 'incoming',
      }),
    ).toEqual([]);
  });
});

// ── order and filter capability ─────────────────────────────────────────────

describe('EvertraceAdapter — what an author may filter and order', () => {
  const adapter = withoutClient();

  const edgeOn = async (typeRef: string, edgeName: string) =>
    (await adapter.describe(typeRef))?.references.find((r) => r.name === edgeName);

  it('lets a WHERE and an ORDER BY cross every edge bounded by the record it leaves', async () => {
    for (const [typeRef, edgeName] of [
      ['List', 'Entries'],
      ['Signal', 'List Entries'],
      ['Signal', 'Experiences'],
      ['Signal', 'Educations'],
      ['Search', 'Signals'],
    ] as const) {
      expect([edgeName, (await edgeOn(typeRef, edgeName))?.capability]).toEqual([
        edgeName,
        { filter: 'bounded', order: 'bounded', supportsLimit: true },
      ]);
    }
  });

  it('promises the order the adapter actually fetches in, and nothing more', async () => {
    expect((await edgeOn('List', 'Entries'))?.sequenced).toBe('chronological');
    expect((await edgeOn('Signal', 'List Entries'))?.sequenced).toBe('chronological');
    expect((await edgeOn('Signal', 'Experiences'))?.sequenced).toBe('document');
    // A saved search's endpoint documents no order, so the edge promises none.
    expect((await edgeOn('Search', 'Signals'))?.sequenced).toBeUndefined();
  });

  it('marks `Added At` orderable — the one field Evertrace sorts entries by', async () => {
    const entryType = await adapter.describe('List Entry');
    expect(entryType?.fields.find((f) => f.displayName === 'Added At')?.capability).toEqual({
      orderable: true,
    });
  });

  it('says a root collection takes a WHERE but not an ORDER BY', async () => {
    // Evertrace's query endpoint filters and does not sort, so the collection
    // says exactly that: narrow at the source, order in the engine.
    const root = await adapter.describe(ADAPTER_META_TYPE_ID);
    const collection = (name: string) => root?.references.find((r) => r.name === name)?.capability;
    expect(collection('Signals')).toEqual({
      filter: 'native',
      order: 'bounded',
      supportsLimit: true,
    });
    expect(collection('Companies')).toEqual({
      filter: 'native',
      order: 'bounded',
      supportsLimit: true,
    });
    expect(collection('Lists')).toEqual({
      filter: 'bounded',
      order: 'bounded',
      supportsLimit: true,
    });
  });

  it('declares exactly the signal fields `filter.ts` pushes', async () => {
    // The per-field half of a `native` filter: what the checker offers a root
    // WHERE. Every operator here is one `signalFilterFromWhere` acts on, and a
    // field it ignores declares nothing — so a WHERE on it reads as residual.
    const signal = await adapter.describe(EVERTRACE_SIGNAL_TYPE_ID);
    const ops = (name: string) =>
      signal?.fields.find((f) => f.displayName === name)?.capability?.filterOperators;
    expect(ops('Score')).toEqual(['eq', 'gt', 'gte']);
    expect(ops('Name')).toEqual(['eq', 'contains']);
    expect(ops('Country')).toEqual(['eq', 'in', 'contains']);
    expect(ops('Tags')).toEqual(['eq', 'in', 'contains']);
    expect(ops('Discovered At')).toEqual(['gt', 'gte', 'lt', 'lte']);
    expect(ops('Created At')).toEqual(['gt', 'gte']);
    // Held, and searchable by nobody but us.
    expect(ops('Summary')).toBeUndefined();
    // Nothing is orderable: Evertrace's endpoint takes no sort argument.
    expect(signal?.fields.some((f) => f.capability?.orderable === true)).toBe(false);
  });

  it('declares Name as the only filterable field on Companies and Schools', async () => {
    // Companies/Schools declare `filter: 'native'` but `lookupSearchTerm`
    // (filter.ts) only ever reads `Name` — so a WHERE on any other field must
    // read as residual, not silently best-effort.
    for (const [typeId, displayName] of [
      [EVERTRACE_COMPANY_TYPE_ID, 'Company'],
      [EVERTRACE_SCHOOL_TYPE_ID, 'School'],
    ] as const) {
      const descriptor = await adapter.describe(typeId);
      expect([displayName, descriptor?.fields.find((f) => f.displayName === 'Name')?.capability]).toEqual([
        displayName,
        { filterOperators: ['eq', 'contains'] },
      ]);
      expect(
        descriptor?.fields
          .filter((f) => f.displayName !== 'Name')
          .every((f) => f.capability?.filterOperators === undefined),
      ).toBe(true);
    }
  });

  // The checker reads the PROJECTION, not the descriptor — so assert the
  // capability at the currency the hop gate actually consults.
  it('carries the root capability through to the CHECKER projection', async () => {
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (
        await Promise.all(
          entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
        )
      ).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
    );
    const metaDescriptor = await adapter.describe(ADAPTER_META_TYPE_ID);
    const { schema, notes } = instanceSchemaFromDescriptors({
      adapterType: 'evertrace',
      entries,
      descriptors,
      ...(metaDescriptor !== null ? { metaDescriptor } : {}),
      supportsInPlaceUpdate: true,
    });
    expect(schema.collections.Signals).toEqual({
      target: 'Signal',
      capability: { filter: 'native', order: 'bounded', supportsLimit: true },
      listenable: true,
      delivery: 'polled',
      pollEverySeconds: 300,
      cursor: true,
    });
    expect(schema.collections.Lists).toEqual({
      target: 'List',
      capability: { filter: 'bounded', order: 'bounded', supportsLimit: true },
    });
    expect(schema.positions.Signal?.propertyCapabilities?.Score).toEqual({
      filterOperators: ['eq', 'gt', 'gte'],
    });
    // The meta node and the entry list name the same collections.
    expect(notes.filter((n) => n.includes('root descriptor'))).toEqual([]);
    // What `deleteRecord` removes declares it; a signal (Evertrace's own) does not.
    expect(schema.positions.List?.deletable).toBe(true);
    expect(schema.positions.Search?.deletable).toBe(true);
    expect(schema.positions.Signal?.deletable).toBeUndefined();
  });
});

describe('EvertraceAdapter — the entries fetch carries its own order', () => {
  it('always asks Evertrace for creation order, ascending, when the hop asks for nothing', async () => {
    const listListEntries = jest.fn(async () => ({
      data: [listEntry()],
      meta: { page: 1, limit: 100 },
    }));
    const adapter = adapterWith(fakeClient({ listListEntries }));
    await adapter.getRelated({
      position: at('List', 'lst-1', list()),
      fieldId: 'Entries',
      direction: 'outgoing',
    });
    expect(listListEntries).toHaveBeenCalledWith('lst-1', {
      page: 1,
      limit: 100,
      sortBy: 'entry_created_at',
      sortOrder: 'asc',
    });
  });

  it('flips the fetch when the hop orders by `Added At` descending', async () => {
    const listListEntries = jest.fn(async () => ({
      data: [listEntry()],
      meta: { page: 1, limit: 100 },
    }));
    const adapter = adapterWith(fakeClient({ listListEntries }));
    await adapter.getRelated({
      position: at('List', 'lst-1', list()),
      fieldId: 'Entries',
      direction: 'outgoing',
      orderBy: { fieldId: 'Added At', direction: 'desc' },
      limit: 5,
    });
    expect(listListEntries).toHaveBeenCalledWith('lst-1', {
      page: 1,
      limit: 5,
      sortBy: 'entry_created_at',
      sortOrder: 'desc',
    });
  });

  it('leaves the fetch in creation order when the hop orders by anything else', async () => {
    const listListEntries = jest.fn(async () => ({
      data: [listEntry()],
      meta: { page: 1, limit: 100 },
    }));
    const adapter = adapterWith(fakeClient({ listListEntries }));
    await adapter.getRelated({
      position: at('List', 'lst-1', list()),
      fieldId: 'Entries',
      direction: 'outgoing',
      orderBy: { fieldId: 'Something Else', direction: 'desc' },
    });
    expect(listListEntries).toHaveBeenCalledWith('lst-1', {
      page: 1,
      limit: 100,
      sortBy: 'entry_created_at',
      sortOrder: 'asc',
    });
  });

  // The contract on `GetRelatedInput.limit`: a LIMIT may only be honoured
  // alongside the sort it arrived with. A fetch that cannot push the hop's
  // ORDER BY returns everything and lets the engine order and slice it.
  it('drops the LIMIT when the hop orders by a field the entries fetch cannot sort by', async () => {
    const pages = jest.fn(async (_id: string, opts: { page?: number }) =>
      opts.page === 1
        ? { data: [listEntry({ id: 'a' }), listEntry({ id: 'b' })], meta: { page: 1, limit: 100 } }
        : { data: [], meta: { page: 2, limit: 100 } },
    );
    const adapter = adapterWith(fakeClient({ listListEntries: pages }));
    const entries = await adapter.getRelated({
      position: at('List', 'lst-1', list()),
      fieldId: 'Entries',
      direction: 'outgoing',
      orderBy: { fieldId: 'Something Else', direction: 'desc' },
      limit: 1,
    });
    // Paged at the full page size, not at 1 — and both rows come back for the
    // engine to sort and cut.
    expect(pages.mock.calls[0]?.[1]).toMatchObject({ limit: 100, sortOrder: 'asc' });
    expect(entries).toHaveLength(2);
  });

  it('drops the LIMIT on a signal’s memberships when the order is not `Added At`', async () => {
    const scrambled = [
      listEntry({ id: 'ent-b', createdAt: 300 }),
      listEntry({ id: 'ent-a', createdAt: 100 }),
    ];
    const adapter = adapterWith(fakeClient({ listSignalEntries: async () => scrambled }));
    const related = await adapter.getRelated({
      position: at('Signal', 'sig-1', signal()),
      fieldId: 'List Entries',
      direction: 'outgoing',
      orderBy: { fieldId: 'Score', direction: 'desc' },
      limit: 1,
    });
    expect(related).toHaveLength(2);
  });

  it('puts a signal’s memberships in order itself, before a LIMIT slices them', async () => {
    const scrambled = [
      listEntry({ id: 'ent-b', createdAt: 300 }),
      listEntry({ id: 'ent-a', createdAt: 100 }),
      listEntry({ id: 'ent-c', createdAt: 200 }),
    ];
    const adapter = adapterWith(fakeClient({ listSignalEntries: async () => scrambled }));
    const idsOf = (related: Array<{ position: unknown }>) =>
      related.map((r) => (positionData(r.position as never) as EvertraceListEntry).id);

    expect(
      idsOf(
        await adapter.getRelated({
          position: at('Signal', 'sig-1', signal()),
          fieldId: 'List Entries',
          direction: 'outgoing',
        }),
      ),
    ).toEqual(['ent-a', 'ent-c', 'ent-b']);

    expect(
      idsOf(
        await adapter.getRelated({
          position: at('Signal', 'sig-1', signal()),
          fieldId: 'List Entries',
          direction: 'outgoing',
          orderBy: { fieldId: 'Added At', direction: 'desc' },
          limit: 1,
        }),
      ),
    ).toEqual(['ent-b']);
  });
});

// ── WHERE pushdown ──────────────────────────────────────────────────────────

const property = (name: string): Expression => ({ type: 'property', propertyTypeId: name });
/** How a hop's WHERE actually spells a bare backticked field. */
const edgeProperty = (name: string): Expression => ({ type: 'edge_property', propertyTypeId: name });
const value = (v: string | number): Expression => ({ type: 'static', value: v });
const compare = (op: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains', left: Expression, right: Expression): Expression =>
  ({ type: 'compare', op, left, right });
const and = (...operands: Expression[]): Expression => ({ type: 'logical', op: 'and', operands });

describe('signalFilterFromWhere', () => {
  it('pushes nothing when the hop places no WHERE', () => {
    expect(signalFilterFromWhere(undefined)).toEqual({});
  });

  it('maps each named field onto its Evertrace filter key', () => {
    const filter = signalFilterFromWhere(
      and(
        compare('gte', property('Score'), value(7)),
        compare('eq', property('Country'), value('United Kingdom')),
        compare('in', property('City'), { type: 'list', elements: [value('London'), value('Leeds')] }),
        compare('eq', property('Gender'), value('woman')),
        compare('eq', property('Age'), value('30 to 34')),
        compare('contains', property('Tags'), value('YC Alumni')),
        compare('eq', property('Source'), value('linkedin')),
        compare('eq', property('Region'), value('Europe')),
        compare('contains', property('Name'), value('Byron')),
      ),
    );
    expect(filter).toEqual<EvertraceSignalFilter>({
      score: '7',
      country: ['United Kingdom'],
      city: ['London', 'Leeds'],
      gender: ['woman'],
      age: ['30 to 34'],
      profile_tags: ['YC Alumni'],
      source: ['linkedin'],
      region: ['Europe'],
      fullname: 'Byron',
    });
  });

  it('pushes a BARE backticked field, which a hop spells as an edge_property', () => {
    // The form every real hop takes — `Signals WHERE `Score` >= 7`. Matching
    // only `property` here left the whole pushdown dead in the engine.
    expect(
      signalFilterFromWhere(
        and(
          compare('gte', edgeProperty('Score'), value(7)),
          compare('contains', edgeProperty('Tags'), value('New Patent')),
          compare('eq', edgeProperty('Country'), value('Portugal')),
        ),
      ),
    ).toEqual<EvertraceSignalFilter>({
      score: '7',
      type: ['New Patent'],
      country: ['Portugal'],
    });
    expect(lookupSearchTerm(compare('contains', edgeProperty('Name'), value('North')))).toBe('North');
  });

  it('routes a Tags value by which vocabulary it belongs to', () => {
    // The one `Tags` field reads both of Evertrace's tag vocabularies, and each
    // has its own filter key over there.
    expect(signalFilterFromWhere(compare('contains', property('Tags'), value('New Company')))).toEqual({
      type: ['New Company'],
    });
    expect(signalFilterFromWhere(compare('contains', property('Tags'), value('Serial Founder')))).toEqual({
      profile_tags: ['Serial Founder'],
    });
    expect(
      signalFilterFromWhere(
        compare('in', property('Tags'), { type: 'list', elements: [value('New Patent'), value('New Grant')] }),
      ),
    ).toEqual({ type: ['New Patent', 'New Grant'] });
  });

  it('pushes a kind and a profile tag through their own keys when both are required', () => {
    expect(
      signalFilterFromWhere(
        and(
          compare('contains', property('Tags'), value('Stealth Position')),
          compare('contains', property('Tags'), value('YC Alumni')),
        ),
      ),
    ).toEqual({ type: ['Stealth Position'], profile_tags: ['YC Alumni'] });
  });

  it('pushes nothing from a Tags value it does not know, or from a list mixing the two vocabularies', () => {
    expect(signalFilterFromWhere(compare('contains', property('Tags'), value('Left-handed')))).toEqual({});
    // Values within a key are OR'd over there and keys are AND'd, so splitting
    // this list would turn the author's OR into an AND and drop rows.
    expect(
      signalFilterFromWhere(
        compare('in', property('Tags'), { type: 'list', elements: [value('New Company'), value('YC Alumni')] }),
      ),
    ).toEqual({});
  });

  it('turns Discovered At bounds into a date range, and a Created At floor into created_after', () => {
    expect(
      signalFilterFromWhere(
        and(
          compare('gte', property('Discovered At'), value('2026-08-01T00:00:00.000Z')),
          compare('lte', property('Discovered At'), value('2026-08-31T00:00:00.000Z')),
        ),
      ).time_range,
    ).toEqual(['2026-08-01', '2026-08-31']);

    // An upper bound ALONE has no shape to travel in — Evertrace's range starts
    // at a `from` — so it is left to the engine.
    expect(
      signalFilterFromWhere(compare('lte', property('Discovered At'), value('2026-08-31'))),
    ).toEqual({});

    expect(
      signalFilterFromWhere(compare('gt', property('Created At'), value(CREATED_AT))).created_after,
    ).toBe(String(CREATED_AT));
  });

  it('reads a comparison written the other way round', () => {
    expect(signalFilterFromWhere(compare('lte', value(9), property('Score'))).score).toBe('9');
  });

  it('turns a strict score bound into the next integer floor', () => {
    expect(signalFilterFromWhere(compare('gt', property('Score'), value(7))).score).toBe('8');
  });

  it('pushes nothing from an OR or a NOT — a disjunct need not hold of every row', () => {
    const or: Expression = {
      type: 'logical',
      op: 'or',
      operands: [
        compare('eq', property('Country'), value('France')),
        compare('eq', property('Country'), value('Spain')),
      ],
    };
    expect(signalFilterFromWhere(or)).toEqual({});
    expect(signalFilterFromWhere({ type: 'not', expression: compare('eq', property('Country'), value('France')) })).toEqual({});
  });

  it('pushes nothing from a value computed at run time', () => {
    const computed: Expression = { type: 'meta', key: 'now' };
    expect(signalFilterFromWhere(compare('eq', property('Country'), computed))).toEqual({});
  });

  it('finds the lookup search term on a Name equality or contains', () => {
    expect(lookupSearchTerm(compare('contains', property('Name'), value('Analy')))).toBe('Analy');
    expect(lookupSearchTerm(compare('gte', property('Name'), value('Analy')))).toBeUndefined();
    expect(lookupSearchTerm(undefined)).toBeUndefined();
  });
});

describe('the Signals hop reaches Evertrace with the pushed filter', () => {
  it('sends the score floor and the date range in the request body', async () => {
    const listSignals = jest.fn(async () => ({ data: [signal()], meta: { page: 1, limit: 100 } }));
    const adapter = adapterWith(fakeClient({ listSignals }));
    await adapter.getRelated({
      position: makeMetaPosition('evertrace'),
      fieldId: 'Signals',
      direction: 'outgoing',
      where: and(
        compare('gte', property('Score'), value(9)),
        compare('gte', property('Discovered At'), value('2026-08-01T00:00:00.000Z')),
      ),
      limit: 5,
    });
    expect(listSignals).toHaveBeenCalledWith({
      filter: { score: '9', time_range: ['2026-08-01'] },
      page: 1,
      limit: 5,
    });
  });

  it('sends a company Name filter as the lookup’s search term', async () => {
    const listCompanies = jest.fn(async () => ({ data: [], meta: { page: 1, limit: 100 } }));
    const adapter = adapterWith(fakeClient({ listCompanies }));
    await adapter.getRelated({
      position: makeMetaPosition('evertrace'),
      fieldId: 'Companies',
      direction: 'outgoing',
      where: compare('contains', property('Name'), value('Analy')),
    });
    expect(listCompanies).toHaveBeenCalledWith({ page: 1, limit: 100, search: 'Analy' });
  });
});

// ── writes ──────────────────────────────────────────────────────────────────

const write = (recordType: string, fields: Record<string, unknown>) => ({
  recordType,
  fields,
  mutationContext: MUTATION,
});

describe('EvertraceAdapter writes', () => {
  it('creates a saved search, supplying the visit mark and share list itself', async () => {
    const createSearch = jest.fn(async () => search({ id: 'sea-9' }));
    const adapter = adapterWith(fakeClient({ createSearch }));
    const result = await adapter.createRecord(
      write('Search', { Title: 'Stealth in Europe', Emoji: '🔭', Filters: [{ key: 'score', operator: 'gte', value: '7' }] }),
    );
    expect(result.externalId).toBe('sea-9');
    expect(createSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Stealth in Europe',
        emoji: '🔭',
        filters: [{ key: 'score', operator: 'gte', value: '7' }],
        sharees: [],
      }),
    );
  });

  it('rejects a filter row that is not a key, an operator and a value', async () => {
    const adapter = adapterWith(fakeClient());
    await expect(
      adapter.createRecord(write('Search', { Title: 'x', Filters: [{ key: 'score' }] })),
    ).rejects.toThrow(/key, an operator and a value/);
  });

  it('creates a list, and refuses one with no name', async () => {
    const createList = jest.fn(async () => list({ id: 'lst-9' }));
    const adapter = adapterWith(fakeClient({ createList }));
    expect((await adapter.createRecord(write('List', { Name: 'Watchlist' }))).externalId).toBe('lst-9');
    expect(createList).toHaveBeenCalledWith({ name: 'Watchlist', accesses: [] });
    await expect(adapter.createRecord(write('List', {}))).rejects.toThrow(/required/);
  });

  it('files a signal onto a list from the two parent links', async () => {
    const createListEntry = jest.fn(async () => listEntry({ id: 'ent-9' }));
    const adapter = adapterWith(fakeClient({ createListEntry }));
    const result = await adapter.createRecord({
      ...write('List Entry', {}),
      parentLinks: [
        { recordType: 'List', externalId: 'lst-1', edgeName: 'Entries' },
        { recordType: 'Signal', externalId: 'sig-1', edgeName: 'List Entries' },
      ],
    });
    expect(createListEntry).toHaveBeenCalledWith('lst-1', { signalId: 'sig-1' });
    expect(result.externalId).toBe(encodeListEntryId({ listId: 'lst-1', entryId: 'ent-9' }));
  });

  it('says what is missing when a list entry names only one of its ends', async () => {
    const adapter = adapterWith(fakeClient());
    await expect(
      adapter.createRecord({
        ...write('List Entry', {}),
        parentLinks: [{ recordType: 'List', externalId: 'lst-1', edgeName: 'Entries' }],
      }),
    ).rejects.toThrow(/needs both ends/);
  });

  it('refuses to create a signal, and points at the fields that can change', async () => {
    const adapter = adapterWith(fakeClient());
    await expect(adapter.createRecord(write('Signal', {}))).rejects.toThrow(/discovers signals/);
  });

  it('screens and views a signal, and refuses to un-view one', async () => {
    const screenSignal = jest.fn(async () => ({}));
    const markSignalAsViewed = jest.fn(async () => ({}));
    const adapter = adapterWith(fakeClient({ screenSignal, markSignalAsViewed }));
    const result = await adapter.updateRecord({
      ...write('Signal', { Screened: true, Viewed: true }),
      externalId: 'sig-1',
    });
    expect(updateRecordSucceeded(result)).toBe(true);
    expect(screenSignal).toHaveBeenCalledWith('sig-1');
    expect(markSignalAsViewed).toHaveBeenCalledWith('sig-1');

    await expect(
      adapter.updateRecord({ ...write('Signal', { Viewed: false }), externalId: 'sig-1' }),
    ).rejects.toThrow(/cannot un-view/);
  });

  it('treats un-screening an unscreened signal as the state that was asked for', async () => {
    const unscreenSignal = jest.fn(async () => {
      throw new EvertraceApiError(404, 'DELETE', '/signals/sig-1/screenings', '{"_tag":"ScreeningNotFoundError"}');
    });
    const adapter = adapterWith(fakeClient({ unscreenSignal }));
    const result = await adapter.updateRecord({
      ...write('Signal', { Screened: false }),
      externalId: 'sig-1',
    });
    expect(updateRecordSucceeded(result)).toBe(true);
  });

  it('renames a search and a list', async () => {
    const updateSearch = jest.fn(async () => search({ title: 'Renamed' }));
    const updateList = jest.fn(async () => list({ name: 'Renamed' }));
    const adapter = adapterWith(fakeClient({ updateSearch, updateList }));
    await adapter.updateRecord({ ...write('Search', { Title: 'Renamed' }), externalId: 'sea-1' });
    expect(updateSearch).toHaveBeenCalledWith('sea-1', { title: 'Renamed' });
    await adapter.updateRecord({ ...write('List', { Name: 'Renamed' }), externalId: 'lst-1' });
    expect(updateList).toHaveBeenCalledWith('lst-1', { name: 'Renamed' });
  });

  it('reports a vanished record through the typed not-found signal, not an error', async () => {
    const gone = async () => {
      throw new EvertraceApiError(404, 'PUT', '/searches/sea-1', '{"_tag":"SearchNotFoundError"}');
    };
    const adapter = adapterWith(
      fakeClient({ updateSearch: gone, updateList: gone, screenSignal: gone }),
    );
    expect(
      await adapter.updateRecord({ ...write('Search', { Title: 'x' }), externalId: 'sea-1' }),
    ).toEqual({ notFound: true });
    expect(
      await adapter.updateRecord({ ...write('List', { Name: 'x' }), externalId: 'lst-1' }),
    ).toEqual({ notFound: true });
    expect(
      await adapter.updateRecord({ ...write('Signal', { Screened: true }), externalId: 'sig-1' }),
    ).toEqual({ notFound: true });
  });

  it('treats a null update answer as the same fact its 404 carries', async () => {
    const adapter = adapterWith(fakeClient({ updateSearch: async () => null }));
    expect(
      await adapter.updateRecord({ ...write('Search', { Title: 'x' }), externalId: 'sea-1' }),
    ).toEqual({ notFound: true });
  });

  it('deletes searches, lists and memberships, and refuses to delete a signal', async () => {
    const deleteSearch = jest.fn(async () => search());
    const deleteList = jest.fn(async () => list());
    const deleteListEntry = jest.fn(async () => listEntry());
    const adapter = adapterWith(fakeClient({ deleteSearch, deleteList, deleteListEntry }));

    await adapter.deleteRecord({ recordType: 'Search', externalId: 'sea-1', mutationContext: MUTATION });
    expect(deleteSearch).toHaveBeenCalledWith('sea-1');
    await adapter.deleteRecord({ recordType: 'List', externalId: 'lst-1', mutationContext: MUTATION });
    expect(deleteList).toHaveBeenCalledWith('lst-1');
    await adapter.deleteRecord({ recordType: 'List Entry', externalId: 'lst-1:ent-1', mutationContext: MUTATION });
    expect(deleteListEntry).toHaveBeenCalledWith('lst-1', 'ent-1');

    await expect(
      adapter.deleteRecord({ recordType: 'Signal', externalId: 'sig-1', mutationContext: MUTATION }),
    ).rejects.toThrow(/belong to Evertrace/);
    await expect(
      adapter.deleteRecord({ recordType: 'List Entry', externalId: 'bare', mutationContext: MUTATION }),
    ).rejects.toThrow(/does not name a list entry/);
  });

  it('refuses a write against a read-only type', async () => {
    const adapter = adapterWith(fakeClient());
    await expect(adapter.createRecord(write('Company', { Name: 'x' }))).rejects.toThrow(
      /no write surface/,
    );
  });
});

describe('EvertraceAdapter.readRecord', () => {
  it('re-fetches the records that have a fetch behind them, and nothing for the rest', async () => {
    const adapter = adapterWith(fakeClient());
    expect((await adapter.readRecord({ recordType: 'Signal', externalId: 'sig-1' }))?.['id']).toBe('sig-1');
    expect((await adapter.readRecord({ recordType: 'Search', externalId: 'sea-1' }))?.['id']).toBe('sea-1');
    expect((await adapter.readRecord({ recordType: 'List', externalId: 'lst-1' }))?.['id']).toBe('lst-1');
    expect(await adapter.readRecord({ recordType: 'Experience', externalId: 'exp-1' })).toBeNull();
  });

  it('reads a vanished record as nothing', async () => {
    const adapter = adapterWith(
      fakeClient({
        getSignal: async () => {
          throw new EvertraceApiError(404, 'GET', '/signals/sig-1', '{"_tag":"SignalNotFoundError"}');
        },
      }),
    );
    expect(await adapter.readRecord({ recordType: 'Signal', externalId: 'sig-1' })).toBeNull();
  });
});

// ── poll ─────────────────────────────────────────────────────────────

const taking = (field: string, op: string, right: unknown) => ({
  type: 'compare',
  op,
  left: { type: 'property', propertyTypeId: field, fieldOnly: true },
  right: { type: 'static', value: right },
});
const conjunction = (...operands: unknown[]) => ({ type: 'logical', op: 'and', operands });
const ids = (answer: Awaited<ReturnType<typeof pollEvertrace>>) => answer.arrivals.map((a) => ('identity' in a ? a.identity : ''));

describe('pollEvertrace — Signals', () => {
  const poll = (client: EvertraceApiClient, input: { filter?: unknown; cursor?: unknown }) =>
    pollEvertrace(client, { edge: 'Signals', ...input }, { log });

  it('first poll sets the cursor and delivers nothing (no backfill)', async () => {
    const listSignals = jest.fn(async () => ({ data: [signal()], meta: { page: 1, limit: 100 } }));
    const { arrivals, cursor } = await poll(fakeClient({ listSignals }), {});
    expect(arrivals).toEqual([]);
    expect((cursor as { createdAfter: number }).createdAfter).toBeGreaterThan(0);
    expect(listSignals).not.toHaveBeenCalled();
  });

  it('a later poll delivers each signal on Signals, oldest first, and advances the cursor', async () => {
    const older = signal({ id: 'a', createdAt: CREATED_AT });
    const newer = signal({ id: 'b', createdAt: CREATED_AT + 60_000 });
    const listSignals = jest.fn(async () => ({ data: [newer, older], meta: { page: 1, limit: 100 } }));
    const answer = await poll(fakeClient({ listSignals }), { cursor: { createdAfter: CREATED_AT - 1 } });
    expect(ids(answer)).toEqual(['a', 'b']);
    expect(answer.arrivals[0]).toMatchObject({
      edge: 'Signals',
      occurredAt: new Date(CREATED_AT).toISOString(),
      takenApplied: true,
      landing: {
        recordId: 'a',
        recordType: 'Signal',
        fields: expect.objectContaining({ Name: 'Ada Byron', Score: 8, 'Created At': new Date(CREATED_AT).toISOString() }),
      },
    });
    expect((answer.cursor as { createdAfter: number }).createdAfter).toBe(CREATED_AT + 60_000);
    expect(listSignals).toHaveBeenCalledWith({
      filter: { created_after: String(CREATED_AT - 1) },
      page: 1,
      limit: 100,
    });
  });

  it('polls a named saved search through the signal listing, its rows translated and its own cutoff added', async () => {
    const fresh = signal({ id: 'b', createdAt: CREATED_AT + 60_000 });
    const listSignals = jest.fn(async () => ({ data: [fresh], meta: { page: 1, limit: 100 } }));
    const listSearchSignals = jest.fn();
    const answer = await poll(
      fakeClient({
        listSignals,
        listSearchSignals,
        listSearches: async () => [
          search({
            filters: [
              filterRow({ key: 'status', operator: 'in', value: '["Stealth Position"]' }),
              filterRow({ key: 'country', operator: 'not_in', value: 'Japan' }),
              // The search's own time bound never travels: the mark is the cutoff.
              filterRow({ key: 'time_range', operator: 'in', value: '["2026-01-01"]' }),
            ],
          }),
        ],
      }),
      { filter: taking('Saved Search', 'eq', 'Stealth in Europe'), cursor: { createdAfter: CREATED_AT } },
    );
    expect(ids(answer)).toEqual(['b']);
    // The arrival carries the search it came through.
    expect(answer.arrivals[0]).toMatchObject({ landing: { fields: expect.objectContaining({ 'Saved Search': 'Stealth in Europe' }) } });
    expect(listSignals).toHaveBeenCalledWith({
      filter: {
        type: ['Stealth Position'],
        country: ['!Japan'],
        created_after: String(CREATED_AT),
      },
      page: 1,
      limit: 100,
    });
    // The saved-search listing orders by nothing the spec promises, so the poll
    // never asks it.
    expect(listSearchSignals).not.toHaveBeenCalled();
  });

  it('reads each saved search a listen names once over, and a signal two of them match arrives once', async () => {
    const both = signal({ id: 'both', createdAt: CREATED_AT + 1 });
    const listSignals = jest.fn(async () => ({ data: [both], meta: { page: 1, limit: 100 } }));
    const answer = await poll(
      fakeClient({ listSignals, listSearches: async () => [search(), search({ id: 'sea-2', title: 'Other' })] }),
      { filter: taking('Saved Search', 'in', ['Stealth in Europe', 'Other']), cursor: { createdAfter: CREATED_AT } },
    );
    expect(listSignals).toHaveBeenCalledTimes(2);
    expect(ids(answer)).toEqual(['both']);
  });

  it('judges the rest of the taken filter over the signal, and moves the cursor past one that did not match', async () => {
    const strong = signal({ id: 'a', score: 9, createdAt: CREATED_AT + 1 });
    const weak = signal({ id: 'b', score: 3, createdAt: CREATED_AT + 2 });
    const listSignals = jest.fn(async () => ({ data: [strong, weak], meta: { page: 1, limit: 100 } }));
    const answer = await poll(fakeClient({ listSignals }), {
      filter: taking('Score', 'gte', 8),
      cursor: { createdAfter: CREATED_AT },
    });
    expect(ids(answer)).toEqual(['a']);
    expect((answer.cursor as { createdAfter: number }).createdAfter).toBe(CREATED_AT + 2);
  });

  it('leaves a filter it cannot read to the host: nothing claimed applied', async () => {
    const unreadable = { type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'Score' }, right: { type: 'property', propertyTypeId: 'Age' } };
    const listSignals = jest.fn(async () => ({ data: [signal({ createdAt: CREATED_AT + 1 })], meta: { page: 1, limit: 100 } }));
    const answer = await poll(fakeClient({ listSignals }), { filter: unreadable, cursor: { createdAfter: CREATED_AT } });
    expect(answer.arrivals).toHaveLength(1);
    expect(answer.arrivals[0]).not.toHaveProperty('takenApplied');
  });

  it('fetches the search when the listing answers without its rows', async () => {
    const listSignals = jest.fn(async () => ({ data: [], meta: { page: 1, limit: 100 } }));
    const getSearch = jest.fn(async () =>
      search({ id: 'sea-fetch', filters: [filterRow({ key: 'city', operator: 'in', value: 'Paris' })] }),
    );
    await poll(
      fakeClient({
        listSignals,
        getSearch,
        listSearches: async () => [searchWithoutRows()],
      }),
      { filter: taking('Saved Search', 'eq', 'sea-fetch'), cursor: { createdAfter: CREATED_AT } },
    );
    expect(getSearch).toHaveBeenCalledWith('sea-fetch');
    expect(listSignals).toHaveBeenCalledWith({
      filter: { city: ['Paris'], created_after: String(CREATED_AT) },
      page: 1,
      limit: 100,
    });
  });

  it('logs a search’s stored rows verbatim, once per search', async () => {
    const client = fakeClient({
      listSignals: async () => ({ data: [], meta: { page: 1, limit: 100 } }),
      listSearches: async () => [
        search({
          id: 'sea-logged',
          title: 'Logged',
          filters: [
            filterRow({ key: 'status', operator: 'in', value: '["Stealth Position"]' }),
            filterRow({ key: 'gender', operator: 'not_in', value: 'man' }),
          ],
        }),
      ],
    });
    const again = () => poll(client, { filter: taking('Saved Search', 'eq', 'sea-logged'), cursor: { createdAfter: CREATED_AT } });
    await again();
    const said = log.info.mock.calls.map((c) => String(c[0]));
    expect(said.some((line) => line.includes('"key":"status"'))).toBe(true);
    // The row it could not express is named too — that is how the real
    // operator vocabulary is discovered.
    expect(said.some((line) => line.includes('this key has no exclude form'))).toBe(true);

    log.info.mockClear();
    await again();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('polls on the mark alone, and warns, when nothing in the search can be expressed', async () => {
    const listSignals = jest.fn(async () => ({ data: [], meta: { page: 1, limit: 100 } }));
    await poll(
      fakeClient({
        listSignals,
        listSearches: async () => [
          search({
            id: 'sea-unreadable',
            title: 'Unreadable',
            filters: [filterRow({ key: 'country', operator: 'between', value: 'France' })],
          }),
        ],
      }),
      { filter: taking('Saved Search', 'eq', 'sea-unreadable'), cursor: { createdAfter: CREATED_AT } },
    );
    expect(listSignals).toHaveBeenCalledWith({
      filter: { created_after: String(CREATED_AT) },
      page: 1,
      limit: 100,
    });
    expect(log.warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('sea-unreadable'),
    ]);
  });

  it('names the searches it can see when the listen names one it cannot', async () => {
    await expect(
      poll(fakeClient(), { filter: taking('Saved Search', 'eq', 'Nope'), cursor: { createdAfter: CREATED_AT } }),
    ).rejects.toThrow(/no saved search called "Nope"/);
  });

  it('refuses an edge it does not have, by name', async () => {
    await expect(pollEvertrace(fakeClient(), { edge: 'Searches', cursor: { createdAfter: CREATED_AT } }, { log })).rejects.toThrow(
      '@lf/evertrace: no edge Searches to poll (its listenable edges are Signals and List Entries)',
    );
  });
});

// ── poll: list additions ─────────────────────────────────────────────

describe('pollEvertrace — List Entries', () => {
  const poll = (client: EvertraceApiClient, input: { filter?: unknown; cursor?: unknown }) =>
    pollEvertrace(client, { edge: 'List Entries', ...input }, { log });

  it('first poll sets the cursor and delivers nothing (no backfill)', async () => {
    const listListEntries = jest.fn(async () => ({ data: [listEntry()], meta: { page: 1, limit: 100 } }));
    const { arrivals, cursor } = await poll(fakeClient({ listListEntries }), {});
    expect(arrivals).toEqual([]);
    expect((cursor as { createdAfter: number }).createdAfter).toBeGreaterThan(0);
    expect(listListEntries).not.toHaveBeenCalled();
  });

  it('delivers each new entry, oldest first, keyed by (list, entry) and about its signal', async () => {
    const older = listEntry({ id: 'ent-a', createdAt: CREATED_AT + 1_000 });
    const newer = listEntry({ id: 'ent-b', createdAt: CREATED_AT + 60_000 });
    const seen = listEntry({ id: 'ent-old', createdAt: CREATED_AT - 60_000 });
    const listListEntries = jest.fn(async () => ({
      data: [newer, older, seen],
      meta: { page: 1, limit: 100 },
    }));
    const answer = await poll(fakeClient({ listListEntries }), { cursor: { createdAfter: CREATED_AT } });
    expect(ids(answer)).toEqual(['lst-1:ent-a', 'lst-1:ent-b']);
    expect(answer.arrivals[0]).toMatchObject({
      edge: 'List Entries',
      occurredAt: new Date(CREATED_AT + 1_000).toISOString(),
      about: { recordType: 'Signal', externalId: 'sig-1' },
      takenApplied: true,
      landing: {
        recordType: 'List Entry',
        fields: expect.objectContaining({ 'Added At': new Date(CREATED_AT + 1_000).toISOString(), 'List Id': 'lst-1', 'List Name': 'Watchlist' }),
      },
    });
    expect((answer.cursor as { createdAfter: number }).createdAfter).toBe(CREATED_AT + 60_000);
    // Newest first, so the walk can stop at the mark.
    expect(listListEntries).toHaveBeenCalledWith('lst-1', {
      page: 1,
      limit: 100,
      sortBy: 'entry_created_at',
      sortOrder: 'desc',
    });
  });

  it('pages until a page carries something already seen', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      listEntry({ id: `p1-${i}`, createdAt: CREATED_AT + 100_000 - i }),
    );
    const page2 = [
      listEntry({ id: 'p2-fresh', createdAt: CREATED_AT + 1 }),
      listEntry({ id: 'p2-seen', createdAt: CREATED_AT - 1 }),
    ];
    const listListEntries = jest.fn(async (_listId: string, opts: { page?: number }) => ({
      data: opts.page === 1 ? page1 : page2,
      meta: { page: opts.page ?? 1, limit: 100 },
    }));
    const answer = await poll(fakeClient({ listListEntries }), { cursor: { createdAfter: CREATED_AT } });
    expect(listListEntries).toHaveBeenCalledTimes(2);
    expect(answer.arrivals).toHaveLength(101);
    expect(ids(answer).includes('lst-1:p2-seen')).toBe(false);
  });

  it('covers every list in the workspace when the listen names none', async () => {
    const listLists = jest.fn(async () => [list(), list({ id: 'lst-2', name: 'Pipeline' })]);
    const listListEntries = jest.fn(async (listId: string) => ({
      data: [listEntry({ id: `ent-${listId}`, listId, createdAt: CREATED_AT + 1 })],
      meta: { page: 1, limit: 100 },
    }));
    const answer = await poll(fakeClient({ listLists, listListEntries }), { cursor: { createdAfter: CREATED_AT } });
    expect(ids(answer)).toEqual(['lst-1:ent-lst-1', 'lst-2:ent-lst-2']);
  });

  it('narrows to the lists a listen names, by name or by id, each read once', async () => {
    // The default fixture list is 'Watchlist' (lst-1); 'Pipeline' is the other.
    const listLists = async () => [list(), list({ id: 'lst-2', name: 'Pipeline' })];
    for (const named of ['Pipeline', 'pipeline', 'lst-2']) {
      const asked: string[] = [];
      const listListEntries = async (listId: string) => {
        asked.push(listId);
        return { data: [], meta: { page: 1, limit: 100 } };
      };
      await poll(fakeClient({ listLists, listListEntries }), { filter: taking('List Name', 'eq', named), cursor: { createdAfter: CREATED_AT } });
      expect(asked).toEqual(['lst-2']);
    }
    const asked: string[] = [];
    await poll(
      fakeClient({ listLists, listListEntries: async (listId: string) => (asked.push(listId), { data: [], meta: { page: 1, limit: 100 } }) }),
      { filter: taking('List Name', 'in', ['Pipeline', 'Watchlist']), cursor: { createdAfter: CREATED_AT } },
    );
    expect(asked).toEqual(['lst-2', 'lst-1']);
  });

  it('judges a List Id it takes over the entry', async () => {
    const listLists = async () => [list(), list({ id: 'lst-2', name: 'Pipeline' })];
    const listListEntries = async (listId: string) => ({
      data: [listEntry({ id: `ent-${listId}`, listId, createdAt: CREATED_AT + 1 })],
      meta: { page: 1, limit: 100 },
    });
    const answer = await poll(fakeClient({ listLists, listListEntries }), {
      filter: conjunction(taking('List Id', 'eq', 'lst-2')),
      cursor: { createdAfter: CREATED_AT },
    });
    expect(ids(answer)).toEqual(['lst-2:ent-lst-2']);
  });

  it('names the lists it can see when the listen names one it cannot', async () => {
    await expect(
      poll(fakeClient(), { filter: taking('List Name', 'eq', 'Nope'), cursor: { createdAfter: CREATED_AT } }),
    ).rejects.toThrow(/no list called "Nope"/);
  });

  it('a Signals poll never pulls entries, and a List Entries poll never pulls signals', async () => {
    const fakes = () => ({
      listSignals: jest.fn(async () => ({ data: [signal({ createdAt: CREATED_AT + 1 })], meta: { page: 1, limit: 100 } })),
      listListEntries: jest.fn(async () => ({
        data: [listEntry({ createdAt: CREATED_AT + 1 })],
        meta: { page: 1, limit: 100 },
      })),
    });

    const forEntries = fakes();
    await poll(fakeClient(forEntries), { cursor: { createdAfter: CREATED_AT } });
    expect(forEntries.listSignals).not.toHaveBeenCalled();

    const forSignals = fakes();
    await pollEvertrace(fakeClient(forSignals), { edge: 'Signals', cursor: { createdAfter: CREATED_AT } }, { log });
    expect(forSignals.listListEntries).not.toHaveBeenCalled();
  });
});
