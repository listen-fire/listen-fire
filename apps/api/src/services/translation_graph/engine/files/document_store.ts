// A document-store-backed FileRef — the producer for files that live in Listen-Fire's
// own document storage rather than behind an external adapter (the `FILE()`
// render artifact, async user interaction §4.1).
//
// Unlike a source-adapter FileRef (whose bytes are served by the owning adapter's
// `resolveFileRef`), this one's owner is the global document store itself
// (`services.document`, no per-team creds). Its `retrieve()` streams from the
// store by `objectUri`, and its `source` handle (`document-store` / objectUri)
// survives serialisation — so a serialise → rehydrate round-trip rebinds the same
// byte channel (the durable-park reviver maps `DOCUMENT_STORE_OWNER` here).
//
// This mirrors the web adapter's `buildFileResource` retriever, factored out so
// both the `FILE()` artifact and the rehydration reviver share one builder.
//
// FILE() persists to S3

import { services } from '../../../../adapters/registry';
import type { FileRef } from '../../adapter';

/** The `source.ownerAdapterType` marker for a document-store-backed FileRef. Not
 *  an adapter — the reviver recognises it and streams from `services.document`
 *  directly, exactly as `retrieve()` does here. */
export const DOCUMENT_STORE_OWNER = 'document-store';

export interface DocumentStoreFileRefInput {
  /** The store handle (`services.document.upload`'s returned `objectUri`). */
  objectUri: string;
  name?: string;
  contentType?: string;
  size?: number;
}

/**
 * Build a durable, document-store-backed `FileRef`. `retrieve()` opens a fresh
 * store read each call (re-callable), and `source` carries the objectUri so the
 * ref round-trips through serialisation.
 */
export function documentStoreFileRef(input: DocumentStoreFileRefInput): FileRef {
  const { objectUri, name, contentType, size } = input;
  return {
    __brand: 'FileRef',
    ...(name !== undefined ? { name } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
    ...(size !== undefined ? { size } : {}),
    retrieve: async () => {
      const stream = await services.document.getFileNodeStream({ objectUri });
      return {
        stream,
        contentType: stream.contentType ?? contentType,
        size: stream.size ?? size,
      };
    },
    source: { ownerAdapterType: DOCUMENT_STORE_OWNER, handle: objectUri },
  };
}
