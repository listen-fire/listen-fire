// Bright Data's limits off the platform are the limiter slot's: the SERP zone
// at 14 requests a minute, the Web Unlocker at ten in flight, each zone a
// caller of its own, and a 429 (the HTTP status, or Bright Data's own in
// `x-brd-status-code`) closes that zone's caller for the wait it asked, else
// the platform's default.

import { moduleContext, refusingFiles, refusingKv } from 'module-kit';
import { installLimiter, MemoryLimiter } from 'movement-engine/public/limiter';

import { standaloneTools } from '../standalone';
import type { WebTools } from '../tools';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const SERP_REPLY = JSON.stringify({ organic: [{ link: 'https://example.com', title: 'Example', description: 'x' }] });
const PAGE = '<html><body>a page with words enough to read</body></html>';

type Answer = (zone: string, n: number) => Promise<Response>;

/** The standalone tools over a Bright Data stand-in answering `answer`. */
async function toolsOver(answer: Answer): Promise<{ tools: WebTools; sent: (zone: string) => number }> {
  const counts = new Map<string, number>();
  const fetchImpl: typeof fetch = async (_input, init) => {
    const { zone } = JSON.parse(String(init?.body));
    const n = (counts.get(zone) ?? 0) + 1;
    counts.set(zone, n);
    return answer(zone, n);
  };
  const ctx = moduleContext({
    tenant: 't',
    credential: {
      name: 'web',
      fields: async () => ({ brightDataAccessToken: 'token', brightDataSerpZone: 'serp_zone', brightDataUnlockerZone: 'unlocker_zone' }),
      update: async () => undefined,
    },
    fetch: fetchImpl,
    log: quiet,
    files: refusingFiles('none'),
    kv: refusingKv('none'),
    validateResults: false,
  });
  return { tools: await standaloneTools(ctx), sent: (zone) => counts.get(zone) ?? 0 };
}

const ok = (zone: string) =>
  zone === 'serp_zone'
    ? new Response(SERP_REPLY, { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });

describe("Bright Data's limits off the platform", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-10-22T12:00:00Z') });
    installLimiter(new MemoryLimiter());
  });

  afterEach(() => {
    installLimiter(new MemoryLimiter());
    jest.useRealTimers();
  });

  it('sends at most 14 searches a minute through the SERP zone; the fifteenth waits its turn', async () => {
    const { tools, sent } = await toolsOver(async (zone) => ok(zone));
    const searches = Array.from({ length: 15 }, (_, i) => tools.search(`q${i}`));
    await jest.advanceTimersByTimeAsync(0);
    expect(sent('serp_zone')).toBe(14);
    // Rolling window: the fifteenth leaves when the first call's minute ends, not on a refill schedule.
    await jest.advanceTimersByTimeAsync(59_990);
    expect(sent('serp_zone')).toBe(14);
    await jest.advanceTimersByTimeAsync(20);
    expect(sent('serp_zone')).toBe(15);
    await Promise.all(searches);
  });

  it('keeps at most ten Web Unlocker requests in flight', async () => {
    const waiting: Array<() => void> = [];
    const { tools, sent } = await toolsOver((zone) => new Promise((resolve) => waiting.push(() => resolve(ok(zone)))));
    const pages = Array.from({ length: 12 }, (_, i) => tools.scrape(`https://example.com/${i}`));
    await jest.advanceTimersByTimeAsync(0);
    expect(sent('unlocker_zone')).toBe(10);
    waiting.shift()?.();
    await jest.advanceTimersByTimeAsync(0);
    expect(sent('unlocker_zone')).toBe(11);
    while (waiting.length > 0) {
      waiting.shift()?.();
      await jest.advanceTimersByTimeAsync(0);
    }
    await Promise.all(pages);
  });

  it("a SERP 429 in x-brd-status-code closes the SERP zone for 30s, and not the Unlocker's", async () => {
    const { tools, sent } = await toolsOver(async (zone, n) =>
      zone === 'serp_zone' && n === 1 ? new Response('', { status: 200, headers: { 'x-brd-status-code': '429' } }) : ok(zone),
    );
    await expect(tools.search('first')).rejects.toThrow('Bright Data answered 429 Too Many Requests on zone serp_zone');

    await expect(tools.scrape('https://example.com/a')).resolves.toContain('a page');
    const next = tools.search('second');
    await jest.advanceTimersByTimeAsync(29_999);
    expect(sent('serp_zone')).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toMatchObject({ items: [{ link: 'https://example.com' }] });
  });

  it("an Unlocker 429 closes the Unlocker zone for Bright Data's Retry-After", async () => {
    const { tools, sent } = await toolsOver(async (zone, n) =>
      n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '5' } }) : ok(zone),
    );
    await expect(tools.scrape('https://example.com/a')).rejects.toThrow('429');
    const next = tools.scrape('https://example.com/b');
    await jest.advanceTimersByTimeAsync(4_999);
    expect(sent('unlocker_zone')).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toContain('a page');
  });
});
