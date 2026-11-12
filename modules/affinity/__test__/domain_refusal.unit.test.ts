// Affinity refuses a domain it considers badly formatted with a 422 naming
// `Field domain`. The write must not fail for that: the organisation is
// written without the domain and the refusal is reported. Every other refusal
// still fails the write.
//
// These drive the real client over a fake `fetch`, so "the client does not
// retry the refusal" is observed as requests on the wire.

jest.mock('movement-engine/public/log', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { AffinityAPIClient } from '../api_client';
import { AffinityOperations } from '../operations';
import { reportAffinityWriteFailuresTo, type AffinityWriteFailure } from '../write_failures';

const BASE = 'https://affinity.test';
const BAD_DOMAIN = 'xn--bcher-kva.example';
const DOMAIN_REFUSAL = '{"errors":[{"message":"Field domain is not a valid domain"}]}';
const OTHER_FIELD_REFUSAL = '{"errors":[{"message":"Field name is too long"}]}';

const models = {
  chat: async (): Promise<string> => 'null',
  chatStructured: async (): Promise<never> => {
    throw new Error('no model call expected');
  },
};
const tracer = { add: () => undefined };

type Sent = { method: string; path: string; body: Record<string, unknown> | undefined };
type Reply = { status: number; body: unknown };

/** Serves `reply` for each request, in the request's own words: undefined means "not expected". */
function serve(reply: (sent: Sent) => Reply | undefined) {
  const sent: Sent[] = [];
  global.fetch = jest.fn(async (input: URL | string, init?: RequestInit) => {
    const request: Sent = {
      method: init?.method ?? 'GET',
      path: new URL(input.toString()).pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    sent.push(request);
    const answer = reply(request);
    if (!answer) throw new Error(`unexpected request: ${request.method} ${request.path}`);
    return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return sent;
}

let keyCounter = 0;
function operationsOnFreshClient() {
  // A client (and its memoised reads) per test, so nothing leaks between them.
  const client = new AffinityAPIClient({ apiKey: `domain-refusal-${keyCounter++}`, baseUrl: BASE });
  return new AffinityOperations(client, models);
}

/** The matcher's search finds nothing, so the write takes the create path. */
const noMatch: Reply = { status: 200, body: { organizations: [], next_page_token: null } };
const isSearch = (s: Sent) => s.method === 'GET' && s.path === '/organizations';

const posts = (sent: Sent[]) => sent.filter((s) => s.method === 'POST' && s.path === '/organizations');

describe('createOrUpdateOrganisation when Affinity refuses a domain', () => {
  const reports: AffinityWriteFailure[] = [];
  const realFetch = global.fetch;

  beforeEach(() => {
    reports.length = 0;
    reportAffinityWriteFailuresTo(async (failure) => {
      reports.push(failure);
    });
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
    // Back to the default (log line) reporter.
    reportAffinityWriteFailuresTo(async () => undefined);
  });

  it('creates again without the domain, returns the new id, and reports once', async () => {
    const sent = serve((s) => {
      if (isSearch(s)) return noMatch;
      if (s.method === 'POST' && s.path === '/organizations') {
        return s.body?.domain
          ? { status: 422, body: DOMAIN_REFUSAL }
          : { status: 200, body: { id: 7001, name: 'Example Labs' } };
      }
      if (s.method === 'GET' && s.path === '/organizations/7001') {
        return { status: 200, body: { id: 7001, name: 'Example Labs' } };
      }
      return undefined;
    });

    const result = await operationsOnFreshClient().createOrUpdateOrganisation({
      searchQuery: { name: 'Example Labs', domain: BAD_DOMAIN },
      userText: '',
      tracer,
      fieldConfigurations: [],
      affinityId: undefined,
    });
    expect(result).toEqual({ id: 7001, isNew: true });

    const creates = posts(sent);
    expect(creates).toHaveLength(2);
    expect(creates[0].body).toMatchObject({ name: 'Example Labs', domain: BAD_DOMAIN });
    expect(creates[1].body?.domain).toBeUndefined();
    expect(creates[1].body).toMatchObject({ name: 'Example Labs' });
    expect(reports).toHaveLength(1);
    expect(reports[0].kind).toBe('domain');
    expect(reports[0].detail).toContain(BAD_DOMAIN);
  });

  it('does not retry the refusal: the domain create is one request', async () => {
    const sent = serve((s) => {
      if (isSearch(s)) return noMatch;
      if (s.method === 'POST' && s.path === '/organizations') {
        return s.body?.domain
          ? { status: 422, body: DOMAIN_REFUSAL }
          : { status: 200, body: { id: 7002, name: 'Example Labs' } };
      }
      if (s.method === 'GET' && s.path === '/organizations/7002') {
        return { status: 200, body: { id: 7002, name: 'Example Labs' } };
      }
      return undefined;
    });

    await operationsOnFreshClient().createOrUpdateOrganisation({
      searchQuery: { name: 'Example Labs', domain: BAD_DOMAIN },
      userText: '',
      tracer,
      fieldConfigurations: [],
    });

    expect(posts(sent).filter((s) => s.body?.domain)).toHaveLength(1);
  });

  it('keeps writing a matched organisation whose domain fill is refused, and reports once', async () => {
    const sent = serve((s) => {
      if (s.method === 'GET' && s.path === '/organizations/7003') {
        return { status: 200, body: { id: 7003, name: 'Example Labs', domain: null, global: false } };
      }
      if (s.method === 'PUT' && s.path === '/organizations/7003') {
        return { status: 422, body: DOMAIN_REFUSAL };
      }
      return undefined;
    });

    const result = await operationsOnFreshClient().createOrUpdateOrganisation({
      searchQuery: { name: 'Example Labs', domain: BAD_DOMAIN },
      userText: '',
      tracer,
      fieldConfigurations: [],
      affinityId: 7003,
    });

    expect(result).toEqual({ id: 7003, isNew: false });
    expect(sent.filter((s) => s.method === 'PUT')).toHaveLength(1);
    expect(reports).toHaveLength(1);
    expect(reports[0].kind).toBe('domain');
    expect(reports[0].detail).toContain('7003');
  });

  // The client retries these with a growing sleep, as before; fake timers skip the sleeps.
  it.each([
    ['a 422 about another field', 422, OTHER_FIELD_REFUSAL, 'Field name is too long'],
    ['a 500', 500, 'boom', '500'],
  ])('still throws for %s, with no create without the domain and no report', async (_label, status, body, message) => {
    jest.useFakeTimers();
    const sent = serve((s) => {
      if (isSearch(s)) return noMatch;
      return s.method === 'POST' ? { status, body } : undefined;
    });

    const outcome = operationsOnFreshClient()
      .createOrUpdateOrganisation({
        searchQuery: { name: 'Example Labs', domain: BAD_DOMAIN },
        userText: '',
        tracer,
        fieldConfigurations: [],
      })
      .then(
        () => 'resolved',
        (e: Error) => e.message,
      );
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(await outcome).toContain(message);
    expect(posts(sent).length).toBeGreaterThanOrEqual(1);
    expect(posts(sent).every((s) => s.body?.domain === BAD_DOMAIN)).toBe(true);
    expect(reports).toHaveLength(0);
  });
});
