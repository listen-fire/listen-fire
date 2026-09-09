// Dry-run adapter wrapper. Wraps a real target Adapter so writes are
// intercepted before they reach the external system, while reads still
// hit live data — the same "simulate the write, observe what would
// happen" shape v3 uses via output_v3/adapters/dry_run.ts.
//
// In dry-run mode the engine still:
//   • resolves entity matches against the real target (so we see whether
//     a record would be matched vs. created),
//   • reads current values for no-op detection (skips that would skip
//     for real),
//   • drives `applyActionPlan` to its normal endpoint so applied plans
//     and diagnostics line up with what a live run would record.
//
// What it doesn't do:
//   • write to external systems (create/update/delete return synthesized
//     results without side effects),
//   • emit RecordMutationEvents (no downstream cascade),
//   • insert linked_object bridges (the engine gates `ensureBridge` on
//     `ctx.dryRun`).

import { randomUUID } from 'node:crypto';
import type {
  Adapter,
  WriteInput,
  WriteResult,
  UpdateInput,
  UpdateResult,
  DeleteInput,
  DeleteResult,
  LinkRecordsInput,
  LinkRecordsResult,
  UnlinkRecordsInput,
  UnlinkRecordsResult,
} from '../adapter';

/**
 * A write the engine *would* have performed, captured during a dry run.
 * `kind: 'update'` carries the live `externalId` it would have written to
 * (matching reads still hit the real target — see file header), so the
 * caller can render "would update the existing record" vs "would create".
 */
export interface CapturedWrite {
  kind: 'create' | 'update' | 'delete' | 'link' | 'unlink';
  /**
   * Adapter that would have received the write — the wrapped target's
   * `adapterType`. With per-action target overrides (M4b) one dry run can
   * capture writes bound for several systems; this is what distinguishes
   * them in the sink output.
   */
  adapterType: string;
  recordType: string;
  fields?: Record<string, unknown>;
  externalId?: string;
  /** `kind: 'link' | 'unlink'` only — the asserted (or severed) edge.
   *  `recordType` / `externalId` above are the from side; the to side
   *  rides here. */
  link?: { edgeName: string; toRecordType: string; toExternalId: string };
}

export type DryRunWriteSink = (write: CapturedWrite) => void;

export function wrapAdapterForDryRun(adapter: Adapter, sink?: DryRunWriteSink): Adapter {
  // Proxy with overrides on the three write methods. Everything else
  // (describe, resolveEntity, getFieldValue, readRecord, capabilities,
  // adapterType, …) passes straight through to the real adapter.
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'createRecord') {
        return async (input: WriteInput): Promise<WriteResult> => {
          // Synthesize a placeholder externalId so downstream children that
          // consume `parent_result.external_id` still execute. It must be a
          // real UUID, not a tagged string: KG-target writes cast a parent /
          // edge reference to a uuid, and a non-uuid id ("dry-run-…") fails
          // that cast. A random uuid is also a valid id for string-id targets
          // (Attio, etc.), so this is safe across adapters.
          sink?.({
            kind: 'create',
            adapterType: target.adapterType,
            recordType: input.recordType,
            fields: input.fields,
          });
          return { adapterType: target.adapterType, externalId: randomUUID(), data: {} };
        };
      }
      if (prop === 'updateRecord') {
        return async (input: UpdateInput): Promise<UpdateResult> => {
          sink?.({
            kind: 'update',
            adapterType: target.adapterType,
            recordType: input.recordType,
            fields: input.fields,
            externalId: input.externalId,
          });
          return { adapterType: target.adapterType, externalId: input.externalId, data: {} };
        };
      }
      if (prop === 'deleteRecord') {
        return async (input: DeleteInput): Promise<DeleteResult> => {
          sink?.({
            kind: 'delete',
            adapterType: target.adapterType,
            recordType: input.recordType,
            externalId: input.externalId,
          });
          return {};
        };
      }
      if (prop === 'linkRecords') {
        // Only present when the wrapped adapter genuinely implements it,
        // so the engine's capability rejection behaves identically under
        // dry run. `created: true` is synthesized like create's externalId
        // — no read against the live target decides idempotence here.
        if (typeof target.linkRecords !== 'function') return undefined;
        return async (input: LinkRecordsInput): Promise<LinkRecordsResult> => {
          sink?.({
            kind: 'link',
            adapterType: target.adapterType,
            recordType: input.from.recordType,
            externalId: input.from.externalId,
            link: {
              edgeName: input.edgeName,
              toRecordType: input.to.recordType,
              toExternalId: input.to.externalId,
            },
          });
          return { created: true };
        };
      }
      if (prop === 'unlinkRecords') {
        // Mirror of linkRecords: present only when the wrapped adapter
        // genuinely implements it; `removed: true` is synthesized — no
        // read against the live target decides idempotence here.
        if (typeof target.unlinkRecords !== 'function') return undefined;
        return async (input: UnlinkRecordsInput): Promise<UnlinkRecordsResult> => {
          sink?.({
            kind: 'unlink',
            adapterType: target.adapterType,
            recordType: input.from.recordType,
            externalId: input.from.externalId,
            link: {
              edgeName: input.edgeName,
              toRecordType: input.to.recordType,
              toExternalId: input.to.externalId,
            },
          });
          return { removed: true };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
