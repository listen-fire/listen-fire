import { fetchUrlToStream } from '../fetch-stream';

describe('fetchUrlToStream error surfacing', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('names the URL and the underlying cause when the network fetch throws', async () => {
    global.fetch = (() => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: new Error('getaddrinfo ENOTFOUND files.example.com'),
      });
    }) as typeof fetch;

    await expect(fetchUrlToStream('https://files.example.com/deal.pdf')).rejects.toThrow(
      /deal\.pdf/,
    );
    await expect(fetchUrlToStream('https://files.example.com/deal.pdf')).rejects.toThrow(
      /ENOTFOUND/,
    );
  });
});
