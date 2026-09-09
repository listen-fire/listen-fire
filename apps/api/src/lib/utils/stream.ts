import { Readable, PassThrough as NodePassThrough } from 'node:stream';

async function streamToBlob(rs: ReadableStream) {
  const chunks: BlobPart[] = [];
  const writable = new WritableStream<BlobPart>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  await rs.pipeTo(writable);
  return new Blob(chunks);
}

async function streamToBuffer(rs: Readable) {
  const chunks = [];
  for await (const chunk of rs) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

class PassThrough<T> extends NodePassThrough {
  push(chunk: T): boolean {
    return super.push(chunk);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return super[Symbol.asyncIterator]();
  }
}

export { streamToBlob, streamToBuffer, PassThrough };
