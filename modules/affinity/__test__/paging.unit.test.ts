// Affinity's v1 collection endpoints answer ONE PAGE at a time: `page_size`
// caps the page (500 is both the default and the maximum) and
// `next_page_token` is present exactly while more remain. A read that takes
// the first page and stops answers "the first 500 records" to a question that
// asked for all of them — silently, and only on workspaces big enough to
// notice.
//
// These tests drive the client against a mocked `fetch` that serves two pages,
// so the walk is asserted on the REQUESTS made (the page token is carried
// forward) as well as on the concatenated result.

jest.mock('movement-engine/public/log', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { AffinityAPIClient } from '../api_client';

const BASE = 'https://affinity.test';

/** Serve `pages` in order for `route`, minting a `next_page_token` for every
 *  page but the last. Returns the URLs requested, so a test can assert the
 *  walk itself rather than only its result. */
function serve(route: string, pages: Record<string, unknown>[]): { urls: string[] } {
  const urls: string[] = [];
  global.fetch = jest.fn(async (url: URL | RequestInfo) => {
    const parsed = new URL(String(url));
    urls.push(String(url));
    if (parsed.pathname !== route) throw new Error(`unexpected route ${parsed.pathname}`);
    const token = parsed.searchParams.get('page_token');
    const index = token === null ? 0 : Number(token);
    const body = {
      ...pages[index],
      ...(index < pages.length - 1 ? { next_page_token: String(index + 1) } : {}),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { urls };
}

function client() {
  return new AffinityAPIClient({ apiKey: 'k', baseUrl: BASE });
}

describe('AffinityAPIClient root enumerations walk every page', () => {
  it('concatenates both pages of organizations and carries the page token forward', async () => {
    const { urls } = serve('/organizations', [
      { organizations: [{ id: 1, name: 'One' }] },
      { organizations: [{ id: 2, name: 'Two' }] },
    ]);

    const orgs = await client().listOrganisations();

    expect(orgs.map((o) => o.id)).toEqual([1, 2]);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]).searchParams.get('page_size')).toBe('500');
    expect(new URL(urls[0]).searchParams.get('page_token')).toBeNull();
    expect(new URL(urls[1]).searchParams.get('page_token')).toBe('1');
  });

  it('filters Affinity\'s global dataset AFTER the full walk, not per page', async () => {
    // A global record on page one and a private one on page two: filtering the
    // first page alone would answer with nothing at all.
    serve('/organizations', [
      { organizations: [{ id: 1, name: 'Global Co', global: true }] },
      { organizations: [{ id: 2, name: 'Mine', global: false }] },
    ]);

    const orgs = await client().listOrganisations();

    expect(orgs.map((o) => o.id)).toEqual([2]);
  });

  it('walks every page of persons', async () => {
    const { urls } = serve('/persons', [
      { persons: [{ id: 10, first_name: 'A', last_name: 'One' }] },
      { persons: [{ id: 11, first_name: 'B', last_name: 'Two' }] },
    ]);

    const persons = await client().listPersons();

    expect(persons.map((p) => p.id)).toEqual([10, 11]);
    expect(urls).toHaveLength(2);
  });

  it('walks every page of opportunities', async () => {
    const { urls } = serve('/opportunities', [
      { opportunities: [{ id: 20, name: 'One' }] },
      { opportunities: [{ id: 21, name: 'Two' }] },
    ]);

    const opportunities = await client().listOpportunities();

    expect(opportunities.map((o) => o.id)).toEqual([20, 21]);
    expect(urls).toHaveLength(2);
  });

  it('narrows the organization walk with a `term`, keeping the paging', async () => {
    const { urls } = serve('/organizations', [
      { organizations: [{ id: 1, name: 'Veltha', domain: 'veltha.ai' }] },
      { organizations: [{ id: 2, name: 'Velthaco', domain: 'velthaco.com' }] },
    ]);

    const orgs = await client().listOrganisations({ term: 'veltha.ai' });

    // A search's first ask is 50; a token behind it means the walk starts over
    // at 500, so this one is three requests.
    expect(orgs.map((o) => o.id)).toEqual([1, 2]);
    expect(urls).toHaveLength(3);
    expect(urls.every((u) => new URL(u).searchParams.get('term') === 'veltha.ai')).toBe(true);
  });

  it('narrows the person walk with a `term`', async () => {
    const { urls } = serve('/persons', [{ persons: [{ id: 10, first_name: 'Jane', last_name: 'Doe' }] }]);

    const persons = await client().listPersons({ term: 'jane@acme.com' });

    expect(persons.map((p) => p.id)).toEqual([10]);
    expect(new URL(urls[0]).searchParams.get('term')).toBe('jane@acme.com');
  });
});

// ── A search asks for 50 ─────────────────────────────────────────────────────
//
// A search is asked to FIND something, and what it finds is near the top: a
// page of 50 carries the same request count as a page of 500 and a tenth of
// the bytes. Affinity does not document how it orders a search, so 50 is only
// ever the whole answer when Affinity says it is (no `next_page_token`), or
// when the record the caller's first rule picks is already in it. Anything
// else asks again exactly as before — 500, from the top, since a page token is
// only good for the page size that minted it.

import { findMatchingOrganisation } from '../common';
import { findMatchingPersonWith } from './paging_people';

/** Serve `records` as Affinity pages a search: `page_size` at a time, from the
 *  offset the token names. */
function serveSearch(route: '/organizations' | '/persons', records: Record<string, unknown>[]): { urls: URL[] } {
  const urls: URL[] = [];
  const key = route === '/organizations' ? 'organizations' : 'persons';
  global.fetch = jest.fn(async (url: URL | RequestInfo) => {
    const parsed = new URL(String(url));
    urls.push(parsed);
    if (parsed.pathname !== route) throw new Error(`unexpected route ${parsed.pathname}`);
    const size = Number(parsed.searchParams.get('page_size') ?? 500);
    const start = Number(parsed.searchParams.get('page_token') ?? 0);
    const body = {
      [key]: records.slice(start, start + size),
      ...(start + size < records.length ? { next_page_token: String(start + size) } : {}),
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { urls };
}

const sizes = (urls: URL[]) => urls.map((u) => u.searchParams.get('page_size'));
const orgs = (n: number, make: (i: number) => Record<string, unknown>) => Array.from({ length: n }, (_, i) => make(i));

describe('an identity search asks for 50', () => {
  const judge = jest.fn(async (_input: { label: string; system: string; userMessage: string }) => 'null');
  const models = {
    chat: judge,
    chatStructured: async (): Promise<never> => {
      throw new Error('the organisation judge makes no structured call');
    },
  };
  beforeEach(() => judge.mockClear());

  it('one page of 50 when that is everything Affinity holds for the term', async () => {
    const { urls } = serveSearch('/organizations', [{ id: 1, name: 'Veltha', domain: 'veltha.ai', global: false }]);

    const match = await findMatchingOrganisation(client(), models, { name: 'Veltha', domain: 'veltha.ai' });

    expect(match?.id).toBe(1);
    expect(sizes(urls)).toEqual(['50']);
  });

  it('a full page that already holds the domain match is enough', async () => {
    const records = orgs(80, (i) => ({ id: i + 1, name: `Veltha ${i}`, domain: i === 10 ? 'veltha.ai' : `v${i}.veltha.ai.example`, global: i % 2 === 0 }));
    const { urls } = serveSearch('/organizations', records);

    const match = await findMatchingOrganisation(client(), models, { name: 'Veltha', domain: 'veltha.ai' });

    expect(match?.id).toBe(11);
    expect(sizes(urls)).toEqual(['50']);
  });

  it('a domain match past the first 50 is still found, by asking for 500', async () => {
    const records = orgs(80, (i) => ({ id: i + 1, name: `Veltha ${i}`, domain: i === 70 ? 'veltha.ai' : `v${i}.veltha.ai.example`, global: false }));
    const { urls } = serveSearch('/organizations', records);

    const match = await findMatchingOrganisation(client(), models, { name: 'Veltha', domain: 'veltha.ai' });

    expect(match?.id).toBe(71);
    expect(sizes(urls)).toEqual(['50', '500']);
    expect(urls[1].searchParams.get('page_token')).toBeNull();
  });

  // The judge picks among candidates, so it is shown exactly what it was shown
  // before: the first 500, workspace and global records both.
  it('the judge sees the workspace and the global candidates of a full answer, not 50 of them', async () => {
    const records = orgs(80, (i) => ({ id: i + 1, name: `Nova ${i}`, domain: null, global: i % 2 === 1 }));
    const { urls } = serveSearch('/organizations', records);

    await findMatchingOrganisation(client(), models, { name: 'Nova' });

    expect(sizes(urls)).toEqual(['50', '500']);
    expect(judge).toHaveBeenCalledTimes(1);
    const shown = JSON.parse(judge.mock.calls[0][0].userMessage) as { organizations: { id: number; global: boolean }[] };
    expect(shown.organizations).toHaveLength(80);
    expect(shown.organizations.some((o) => o.global)).toBe(true);
    expect(shown.organizations.some((o) => !o.global)).toBe(true);
  });

  it('a person matched by email in the first 50 asks once; past it, asks for 500', async () => {
    const near = serveSearch('/persons', orgs(60, (i) => ({ id: i + 1, first_name: 'Jo', last_name: `${i}`, primary_email: i === 3 ? 'jo@x.test' : `jo${i}@x.test`, emails: [] })));
    expect((await findMatchingPersonWith(client(), { name: 'Jo', email: 'jo@x.test' }))?.id).toBe(4);
    expect(sizes(near.urls)).toEqual(['50']);

    const far = serveSearch('/persons', orgs(60, (i) => ({ id: i + 1, first_name: 'Jo', last_name: `${i}`, primary_email: i === 55 ? 'jo@x.test' : `jo${i}@x.test`, emails: [] })));
    expect((await findMatchingPersonWith(client(), { name: 'Jo', email: 'jo@x.test' }))?.id).toBe(56);
    expect(sizes(far.urls)).toEqual(['50', '500']);
  });
});

describe('a read narrowed by a term walks at 500 when 50 is not everything', () => {
  it('reads 50 and stops when that is all', async () => {
    const { urls } = serveSearch('/organizations', [{ id: 1, name: 'Veltha', domain: 'veltha.ai', global: false }]);

    expect((await client().listOrganisations({ term: 'veltha.ai' })).map((o) => o.id)).toEqual([1]);
    expect(sizes(urls)).toEqual(['50']);
  });

  it('walks every page at 500, from the top, when 50 was not everything', async () => {
    const { urls } = serveSearch('/organizations', orgs(1200, (i) => ({ id: i + 1, name: `Acme ${i}`, global: false })));

    const all = await client().listOrganisations({ term: 'Acme' });

    expect(all).toHaveLength(1200);
    expect(sizes(urls)).toEqual(['50', '500', '500', '500']);
    expect(urls.map((u) => u.searchParams.get('page_token'))).toEqual([null, null, '500', '1000']);
  });

  it('the whole workspace is a list, not a search: 500 a page from the start', async () => {
    const { urls } = serveSearch('/organizations', orgs(600, (i) => ({ id: i + 1, name: `Org ${i}`, global: false })));

    expect(await client().listOrganisations()).toHaveLength(600);
    expect(sizes(urls)).toEqual(['500', '500']);
  });
});
