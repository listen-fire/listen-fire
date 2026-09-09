// Affinity TG adapter — entity resolution. Two stages, lowest-cost first
// (mirrors the Airtable adapter):
//   1. Bridge — surface any linked_object already mapping this record type.
//   2. Natural-key search — org matches by domain/name (reusing the
//      operations layer's `findMatchingOrganisation`, the same logic the v3
//      output uses); person matches by email (then a name fallback). A hit is
//      reported as a single all-exact candidate so the engine auto-matches; no
//      hit yields an empty shortlist and the engine creates.
//
// Affinity's natural keys (domain/name for orgs, email for persons) are the
// identity surface — the adapter does NOT consult author-defined constraints
// here (Affinity has no formula filter to compile them against); identity per
// adapter-minimalism is what `findMatchingOrganisation`/email matching express.

import type { AffinityOperations } from '../../../../adapters/affinity/operations';
import type { LinkedObject } from '../../../../generated/kysely/knowledge/LinkedObject';
import type {
  ResolveEntityInput,
  ResolveEntityResult,
  ExternalRecordRef,
} from '../../adapter';
import { AFFINITY_ADAPTER_TYPE, type DecodedTypeId } from './types';
import { logger } from '../../../logger';
import { readOrgBuiltins, readPersonBuiltins } from './shared';

export async function resolveEntity(input: {
  operations: AffinityOperations;
  /** The structured id the adapter recovered from the recordType NAME via its
   *  cache; undefined for an unknown type (drift). */
  decoded: DecodedTypeId | undefined;
  resolve: ResolveEntityInput;
}): Promise<ResolveEntityResult> {
  // The bridge matches on `resolve.recordType` — the NATURAL type name, the
  // same currency the persisted `external_object_type` label carries now.
  const bridge = resolveByBridge(input.resolve);
  if (bridge) return bridge;

  if (!input.decoded) return { candidates: [] };

  if (input.decoded.entity === 'organization') {
    return resolveOrganization(input);
  }
  if (input.decoded.entity === 'person') {
    return resolvePerson(input);
  }
  // list-entry / note / file have no independent identity to resolve — they
  // attach to a parent. The engine creates them unconditionally (deduping a
  // list-entry happens inside createListEntry's dedup window, not here).
  return { candidates: [] };
}

function resolveByBridge(resolve: ResolveEntityInput): ResolveEntityResult | null {
  if (resolve.candidates.length === 0) return null;
  const matching = resolve.candidates
    .filter((c: LinkedObject) => c.external_object_type === resolve.recordType)
    .sort(
      (a, b) =>
        new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
    );
  if (matching.length === 0) return null;
  return {
    candidates: [
      {
        adapterType: AFFINITY_ADAPTER_TYPE,
        externalId: matching[0].external_id,
        data: {},
      },
    ],
  };
}

async function resolveOrganization(input: {
  operations: AffinityOperations;
  resolve: ResolveEntityInput;
}): Promise<ResolveEntityResult> {
  const { name, domain } = readOrgBuiltins(input.resolve.record);
  if (!name && !domain) return { candidates: [] };

  let match: { id: number } | null = null;
  try {
    match = await input.operations.findMatchingOrganisation({
      name: name ?? '',
      domain: domain ?? null,
    });
  } catch (err) {
    logger.warn('[AffinityAdapter.resolveOrganization] match failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { candidates: [] };
  }
  if (!match) return { candidates: [] };

  const data: Record<string, unknown> = {};
  if (name) data.Name = name;
  if (domain) data.Domain = domain;
  const candidate: ExternalRecordRef = {
    adapterType: AFFINITY_ADAPTER_TYPE,
    externalId: String(match.id),
    data,
  };
  return { candidates: [candidate] };
}

async function resolvePerson(input: {
  operations: AffinityOperations;
  resolve: ResolveEntityInput;
}): Promise<ResolveEntityResult> {
  const { name, email } = readPersonBuiltins(input.resolve.record);
  if (!name && !email) return { candidates: [] };

  let match: { id: number } | null = null;
  try {
    match = await input.operations.findMatchingPerson({
      name: name ?? '',
      email: email ?? null,
    });
  } catch (err) {
    logger.warn('[AffinityAdapter.resolvePerson] match failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { candidates: [] };
  }
  if (!match) return { candidates: [] };

  const data: Record<string, unknown> = {};
  if (name) data.Name = name;
  if (email) data.Email = email;
  const candidate: ExternalRecordRef = {
    adapterType: AFFINITY_ADAPTER_TYPE,
    externalId: String(match.id),
    data,
  };
  return { candidates: [candidate] };
}
