// An upload whose source stream dies part-way fails with the source's error,
// promptly, instead of leaving the PUT waiting forever for the rest of its
// declared length. The store is pointed at a local server that reads the
// body and answers only once all of it has arrived, as S3 does.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { S3Adapter } from '../s3';

const DECLARED = 1000;

let server: http.Server;
let store: S3Adapter;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received >= DECLARED) res.writeHead(200, { ETag: '"etag"' }).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the test server has no port');
  store = storeAt(address);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function storeAt({ port }: AddressInfo): S3Adapter {
  return new S3Adapter({
    bucket: 'docs',
    region: 'auto',
    accessKeyId: 'k',
    secretAccessKey: 's',
    endpoint: `http://127.0.0.1:${port}`,
    forcePathStyle: true,
  });
}

/** A tenth of the declared bytes, then the source fails. */
function dyingSource(): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(Buffer.alloc(DECLARED / 10));
        setTimeout(() => this.destroy(new Error('the uploader hung up')), 50);
      }
    },
  });
}

describe('S3Adapter.upload', () => {
  it('stores a whole body and digests it', async () => {
    const { objectUri, checksum } = await store.upload(Readable.from([Buffer.alloc(DECLARED)]), { filename: 'deck.pdf', contentLength: DECLARED });

    expect(objectUri).toMatch(/^s3:\/\/docs\/[\w-]+\/deck\.pdf$/);
    expect(checksum).toMatch(/^[0-9a-f]{32}$/);
  });

  it('fails with the source’s error when the source dies part-way', async () => {
    const started = Date.now();

    await expect(store.upload(dyingSource(), { filename: 'deck.pdf', contentLength: DECLARED })).rejects.toThrow('the uploader hung up');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
