// The loop guard slot: a module told of each record write a run makes
// (plans/cloud-native-2026-10-06/22_everywhere_plan.md, Henry 2026-10-18).
// Empty unless a project names one in `core:`.
//
// The host reads a record back after a run writes it and tells the guard
// (`recordWrite`). Nothing asks the guard anything back: the host's loop
// breaker caps every chain of writes and arrivals, and the slot's `isEcho`
// is retired. The contract is docs/contracts/loop-guard-slot.md; the
// built-in, `@lf/fingerprint-guard`, is `FingerprintGuard` here and in
// listen-fire (crates/lf/src/loop_guard.rs).

import { createHash } from 'node:crypto';

/** A record write, with the record as the source answered it right after
 *  (`null`: the record is gone). `writer` is the listen that wrote it. */
export interface RecordWrite {
  adapter: string;
  recordType: string;
  externalId: string;
  writer: string;
  record: unknown;
}

export interface LoopGuard {
  /** `writer`'s write, remembered; its later write to the same record replaces it. */
  recordWrite(write: RecordWrite): Promise<void>;
}

/** How long the built-in remembers a write. */
export const REMEMBERED_MS = 3_600_000;

function fingerprint(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(record) ?? 'null').digest('hex');
}

/** The built-in, in this process. */
export class FingerprintGuard implements LoopGuard {
  private readonly remembered = new Map<string, { fingerprint: string; expiresAt: number }>();

  async recordWrite(write: RecordWrite): Promise<void> {
    const now = Date.now();
    for (const [key, one] of this.remembered) if (one.expiresAt <= now) this.remembered.delete(key);
    this.remembered.set(JSON.stringify([write.adapter, write.externalId, write.writer]), { fingerprint: fingerprint(write.record), expiresAt: now + REMEMBERED_MS });
  }
}
