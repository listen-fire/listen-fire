// Consumer-side FileRef byte resolution (`streamFileRef`): the producer's
// `retrieve()` is the channel; a FileRef without it is a producer bug.

import { Readable } from 'node:stream';

import type { FileRef } from '../../../adapter';
import { streamFileRef } from '../retrieve';

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

describe('streamFileRef', () => {
  it('uses the producer-supplied retrieve()', async () => {
    const ref: FileRef = {
      __brand: 'FileRef',
      name: 'a.txt',
      contentType: 'text/plain',
      retrieve: async () => ({
        stream: Readable.from(Buffer.from('hello')),
        contentType: 'text/plain',
      }),
    };
    const { stream, contentType } = await streamFileRef(ref);
    expect(await collect(stream)).toBe('hello');
    expect(contentType).toBe('text/plain');
  });

  it('is re-callable — each call yields a fresh stream (producers must support it)', async () => {
    const ref: FileRef = {
      __brand: 'FileRef',
      retrieve: async () => ({ stream: Readable.from(Buffer.from('x')) }),
    };
    expect(await collect((await streamFileRef(ref)).stream)).toBe('x');
    expect(await collect((await streamFileRef(ref)).stream)).toBe('x');
  });

  it('throws when the FileRef carries no byte channel', async () => {
    await expect(streamFileRef({ __brand: 'FileRef' } as FileRef)).rejects.toThrow(
      /byte channel/,
    );
  });
});
