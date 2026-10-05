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

/**
 * Give back the byte channel to every FileRef inside a value that crossed a
 * JSON-only boundary — the remote adapter's wire, or a parked run's stored
 * state. Such a FileRef keeps its metadata and its producer's durable handle
 * (`source`) and loses `retrieve()`, which is a closure; `revive` rebinds it
 * through whatever can redeem the handle. A FileRef that still has its channel
 * is left as it is. Deep, because a file can sit anywhere in a list or a
 * record; a copy, so the stored form is never changed under its reader.
 */
export function reviveFileRefs(value: unknown, revive: (ref: FileRef) => FileRef): unknown {
  if (Array.isArray(value)) return value.map((item) => reviveFileRefs(item, revive));
  if (isFileRef(value)) return typeof value.retrieve === 'function' ? value : revive(value);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = reviveFileRefs(entry, revive);
    return out;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
