// Affinity TG adapter — list-entry create. Lifts the v3 `executeListEntry`
// flow: a list entry adds a parent org/person to an Affinity list, deduping
// against the parent's existing membership, then writes the list-scoped
// custom-field values. The list id is carried by the per-list type id
// (`List Entry — <list>`, whose structured id carries the listId); the parent
// comes from `parentLinks`.
//
// The v3 output also took a per-action `deduplicationWindow` from
// `adapterConfig`; `WriteInput` carries no adapter config, so the TG path
// dedups against the parent's full membership of the list (window = none),
// which is the safe default — an entity already on the list is never
// re-added.

import type { AffinityOperations } from '../../../../adapters/affinity/operations';
import type { WriteInput, WriteResult } from '../../adapter';
import { singleParentLink } from '../../adapter';
import { decodedFixedType, AFFINITY_ADAPTER_TYPE, type DecodedTypeId } from './types';
import { createNoopTracer, writeCustomFieldValues } from './shared';

export async function createListEntry(input: {
  operations: AffinityOperations;
  write: WriteInput;
  /** The structured id the adapter recovered from the write's recordType NAME —
   *  its `listId` pins the target Affinity list (a per-list entry type). */
  decoded: DecodedTypeId;
}): Promise<WriteResult> {
  const { operations, write } = input;

  const listId = input.decoded.listId ?? null;
  if (listId == null) {
    throw new Error(
      'AffinityAdapter.createListEntry: no listId — author the action against a per-list type (`List Entry — <list>`).',
    );
  }

  // A list entry adds a single parent entity to the list — the lone parent.
  const parentLink = singleParentLink(write);
  if (!parentLink) {
    throw new Error('AffinityAdapter.createListEntry: requires a parent organization or person.');
  }
  const parentDecoded = decodedFixedType(parentLink.recordType);
  const entityType =
    parentDecoded?.entity === 'person' ? ('person' as const) : ('organization' as const);
  const entityId = Number(parentLink.externalId);
  if (!Number.isInteger(entityId)) {
    throw new Error(
      `AffinityAdapter.createListEntry: parent externalId "${parentLink.externalId}" is not numeric.`,
    );
  }

  const entryResult = await operations.createListEntry({
    listId,
    entityId,
    entityType,
    deduplicationWindow: undefined,
    tracer: createNoopTracer(),
  });

  // List-scoped custom fields hang off the list entry; only force-overwrite on
  // a freshly-created entry (a deduped existing entry keeps its values).
  const custom = Object.fromEntries(
    Object.entries(write.fields).filter(([, v]) => v != null && v !== ''),
  );
  if (entryResult && Object.keys(custom).length > 0) {
    await writeCustomFieldValues(operations, {
      entityId,
      entityType,
      fieldValues: custom,
      listEntryId: entryResult.id,
      listId,
      forceOverwrite: entryResult.isNew,
    });
  }

  return {
    adapterType: AFFINITY_ADAPTER_TYPE,
    externalId: entryResult ? String(entryResult.id) : '',
    data: {},
  };
}
