import { Readable } from 'node:stream';

interface DocumentProvider {
  upload(
    readable: Readable,
    {
      filename,
      mimeType,
      contentLength,
      keyPrefix,
    }: {
      filename: string;
      mimeType?: string;
      contentLength: number;
      /** Optional isolation prefix for the stored object's key (e.g. a
       *  short-lived `exposed/` namespace). When set, the object key begins
       *  with it, so a presign route can be scoped to that prefix alone. */
      keyPrefix?: string;
    },
  ): Promise<{ objectUri: string; checksum: string }>;

  getFile({ objectUri }: { objectUri: string }): Promise<{
    webStream: ReadableStream;
    ContentLength: number | undefined;
    ContentType: string | undefined;
  } | null>;

  getFileNodeStream({ objectUri }: { objectUri: string }): Promise<
    Readable & {
      size: number;
      contentType?: string;
    }
  >;

  getDownloadUrl({ objectUri }: { objectUri: string }): Promise<string>;

  delete(uri: string): Promise<void>;
}

export { DocumentProvider };
