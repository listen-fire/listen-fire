// web_search — the provider switch and the Bright Data SERP mapping.
//
// `findLinkedIn`/`findTwitter` aren't under test here (they're the same
// regardless of provider); only `.search()`, which is where the provider
// switch and the Bright Data request/response live. `lib/prompts` and
// `lib/anthropic` are mocked purely to keep the module import cheap — nothing
// under test touches them.

jest.mock('../../lib/prompts', () => ({ Prompt: { matchSearchResult: jest.fn() } }));
jest.mock('../../lib/anthropic', () => ({ anthropicChat: jest.fn() }));
jest.mock('../../lib/web_search', () => ({
  webSearch: jest.fn(),
  isAvailable: () => false,
}));

import { WebSearchService } from '../web_search';

const fetchMock = jest.fn();
global.fetch = fetchMock as never;

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  fetchMock.mockReset();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.WEB_SEARCH_PROVIDER;
  process.env.GOOGLE_CUSTOM_SEARCH_API_KEY = 'google-key';
  process.env.GOOGLE_CX = 'google-cx';
  delete process.env.BRIGHT_DATA_ACCESS_TOKEN;
  delete process.env.BRIGHT_DATA_SERP_ZONE;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe('WebSearchService.search — provider switch', () => {
  it('defaults to google when WEB_SEARCH_PROVIDER is unset', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await WebSearchService.search('acme');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain('https://www.googleapis.com/customsearch/v1');
  });

  it('routes to google explicitly', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'google';
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await WebSearchService.search('acme');

    expect(String(fetchMock.mock.calls[0][0])).toContain('googleapis.com');
  });

  it('routes to brightdata', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'brightdata';
    process.env.BRIGHT_DATA_ACCESS_TOKEN = 'token-123';
    process.env.BRIGHT_DATA_SERP_ZONE = 'serp_zone';
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    await WebSearchService.search('acme');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.brightdata.com/request');
  });

  it('rejects an unrecognised value naming the variable and the values', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'bing';

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      'WEB_SEARCH_PROVIDER must be "google" or "brightdata" (got "bing")',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('WebSearchService.search — brightdata request shape', () => {
  beforeEach(() => {
    process.env.WEB_SEARCH_PROVIDER = 'brightdata';
    process.env.BRIGHT_DATA_ACCESS_TOKEN = 'token-123';
    process.env.BRIGHT_DATA_SERP_ZONE = 'serp_zone';
  });

  it('encodes a query with spaces and quotes into the google search url, bearer auth, and the SERP zone', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ organic: [] }));

    await WebSearchService.search('site:linkedin.com/in "Jane Doe" Acme Inc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.brightdata.com/request');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer token-123',
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(options.body as string);
    expect(body.zone).toBe('serp_zone');
    expect(body.format).toBe('raw');

    const requestedUrl = new URL(body.url);
    expect(requestedUrl.origin + requestedUrl.pathname).toBe('https://www.google.com/search');
    expect(requestedUrl.searchParams.get('q')).toBe('site:linkedin.com/in "Jane Doe" Acme Inc');
    expect(requestedUrl.searchParams.get('brd_json')).toBe('1');
  });

  it('missing variables fail naming them, without making a request', async () => {
    delete process.env.BRIGHT_DATA_ACCESS_TOKEN;
    delete process.env.BRIGHT_DATA_SERP_ZONE;

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      'Bright Data web search requires BRIGHT_DATA_ACCESS_TOKEN and BRIGHT_DATA_SERP_ZONE to be set',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('missing only the zone names just the zone', async () => {
    delete process.env.BRIGHT_DATA_SERP_ZONE;

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      'Bright Data web search requires BRIGHT_DATA_SERP_ZONE to be set',
    );
  });
});

describe('WebSearchService.search — brightdata response mapping', () => {
  beforeEach(() => {
    process.env.WEB_SEARCH_PROVIDER = 'brightdata';
    process.env.BRIGHT_DATA_ACCESS_TOKEN = 'token-123';
    process.env.BRIGHT_DATA_SERP_ZONE = 'serp_zone';
  });

  it('maps a realistic parsed reply into the shared result type', async () => {
    // Shape documented at https://docs.brightdata.com/scraping-automation/serp-api/
    // (organic[].link/title/description/rank/global_rank; only the three
    // fields callers read — title, link, snippet — are mapped).
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        general: { search_engine: 'google', query: 'Basecamp company', results_cnt: 12_400_000 },
        organic: [
          {
            rank: 1,
            global_rank: 1,
            title: 'Basecamp — Project management software',
            link: 'https://basecamp.com/',
            description: 'A simpler way to work. Basecamp puts everything in one place.',
          },
          {
            rank: 2,
            global_rank: 2,
            title: 'Basecamp (company) - Wikipedia',
            link: 'https://en.wikipedia.org/wiki/Basecamp_(company)',
            description: 'Basecamp, formerly 37signals, is an American software company.',
          },
        ],
        people_also_ask: [{ question: 'Who owns Basecamp?' }],
      }),
    );

    const result = await WebSearchService.search('Basecamp company');

    expect(result.items).toEqual([
      {
        link: 'https://basecamp.com/',
        title: 'Basecamp — Project management software',
        snippet: 'A simpler way to work. Basecamp puts everything in one place.',
      },
      {
        link: 'https://en.wikipedia.org/wiki/Basecamp_(company)',
        title: 'Basecamp (company) - Wikipedia',
        snippet: 'Basecamp, formerly 37signals, is an American software company.',
      },
    ]);
  });

  it('an empty organic array is a real "no results", not an error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ general: { search_engine: 'google', query: 'no such thing' }, organic: [] }),
    );

    const result = await WebSearchService.search('no such thing');

    expect(result.items).toEqual([]);
  });

  it('an unexpected shape fails with a plain error naming the top-level keys', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'zone not found', status: 'failed' }),
    );

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      'Bright Data SERP response did not have the expected shape (top-level keys: error, status)',
    );
  });

  it('a non-JSON body fails plainly', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>not json</html>', { status: 200 }));

    await expect(WebSearchService.search('acme')).rejects.toThrow(
      'Bright Data SERP response was not valid JSON',
    );
  });

  it('a non-2xx response fails naming the status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('zone unauthorized', { status: 403 }));

    await expect(WebSearchService.search('acme')).rejects.toThrow(/403/);
  });
});
