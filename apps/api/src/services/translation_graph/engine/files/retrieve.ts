// Consumer-side FileRef byte resolution.
//
// A consuming adapter calls `streamFileRef(ref)` at the write to get the bytes;
// the channel is the producer-supplied `ref.retrieve()` (lazy-at-write — see
// plans/2026-06-18-fileref-resolution-rework). Byte resolution lives with the
// producer, not the engine — a FileRef that reaches a consumer without a
// `retrieve()` is a producer bug (the remote adapter re-binds wire FileRefs
// before they get here), so this throws rather than guessing.

import type { FileRef, ResolveFileRefResult } from '../../adapter';

export async function streamFileRef(ref: FileRef): Promise<ResolveFileRefResult> {
  if (typeof ref.retrieve === 'function') return ref.retrieve();
  throw new Error(
    'FileRef has no retrieve() — its producer did not supply a byte channel.',
  );
}

/** Structural guard for a branded `FileRef`. */
export function isFileRef(value: unknown): value is FileRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === 'FileRef'
  );
}
