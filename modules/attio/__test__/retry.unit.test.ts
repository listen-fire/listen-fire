jest.mock('movement-engine/public/log', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { AttioAPIClient } from '../api_client';

describe('AttioAPIClient retries', () => {
  const fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  const waits: number[] = [];

  function client() {
    return new AttioAPIClient(
      { accessToken: 't', baseUrl: 'http://attio.test' },
      { retry: { sleep: async (ms) => void waits.push(ms), random: () => 1, baseDelayMs: 100 } },
    );
  }
  const ok = () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  const get = (c: AttioAPIClient) => c.fetch({ route: '/v2/lists', method: 'GET' });

  beforeEach(() => {
    fetchMock.mockReset();
    waits.length = 0;
  });

  it('waits as long as Retry-After asked on a 429, not a fixed window', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(ok());
    await get(client());
    expect(waits).toEqual([1000]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours an HTTP-date Retry-After', async () => {
    const date = new Date(Date.now() + 3000).toUTCString();
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': date } }))
      .mockResolvedValueOnce(ok());
    await get(client());
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(1000);
    expect(waits[0]).toBeLessThanOrEqual(3000);
  });

  it('backs off exponentially on a 429 without Retry-After', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(ok());
    await get(client());
    expect(waits).toEqual([100, 200]);
  });

  it('retries a 503 promptly', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(ok());
    await get(client());
    expect(waits).toEqual([100]);
  });

  it('does not retry a deterministic 4xx', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 403 }));
    await expect(get(client())).rejects.toThrow(/Attio Error: 403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the transport retries without a second layer of waiting', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 429 }));
    await expect(get(client())).rejects.toThrow(/HTTP 429 after 4 attempts/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
