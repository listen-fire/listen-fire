// LLM judge for translation-graph entity resolution. The engine calls
// this when an adapter returns multiple candidate matches and they
// can't be disambiguated by structural rules (single all-exact
// candidate).
//
// Modelled on `services/knowledge_pipeline/consolidate.ts`'s
// `matchPromptDef` — same conservative "decline if uncertain" posture.
// Kept separate because TG entity matching can target ANY adapter
// (Attio, Affinity, KG, …), whereas the KG path is hardcoded to
// extracted-entity → KG-node matching.

import { z } from 'zod';

import { execute } from '../../../lib/prompts/execute';
import { promptDef } from '../../../lib/prompts/definition';
import { logger } from '../../logger';
import type { ExternalRecordRef } from '../adapter';
import { candidateIsAllExact, type UniquenessConstraints } from '../uniqueness';

const entityMatchPromptDef = promptDef({
  description: 'Match an asserted record against candidate records from a target system',
  arguments: ['recordType', 'asserted', 'candidates'] as const,
  messages: [
    {
      role: 'system' as const,
      content: `You are an entity resolution system for a data sync pipeline.

A translation graph wants to write a record to a target system. The target system already
contains one or more candidate records that may represent the same real-world entity as
the asserted record. Decide which (if any) of the candidates IS the same entity.

Consider property values: names, identifiers, domains, emails, dates. Names may differ
slightly between systems (e.g. "Acme Corp" vs "Acme Corporation") — but if the
distinguishing fields (domain, email, primary contact) disagree, the candidates are
different entities even when names match closely.

If multiple candidates look like the same entity as each other, that's a pre-existing
duplicate problem in the target system. Pick the candidate that best matches the
asserted record and flag it via reasoning — don't decline just because the target system
is messy.

If genuinely uncertain (none of the candidates clearly matches; multiple look equally
plausible with no tiebreaker), return null. The pipeline will create a new record
rather than risk an incorrect merge.

Respond with: {"match_index": <number or null>, "confidence": <0-1>, "reasoning": "<explanation>"}`,
    },
    {
      role: 'user' as const,
      content: `Record type: {{{recordType}}}

Asserted record:
{{{asserted}}}

Candidates:
{{{candidates}}}`,
    },
  ],
  validator: z.object({
    match_index: z.number().nullable(),
    confidence: z.number(),
    reasoning: z.string(),
  }),
});

function formatRecord(record: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || value === '') continue;
    const rendered =
      typeof value === 'object' ? JSON.stringify(value) : String(value);
    lines.push(`- ${key}: ${rendered}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(no fields)';
}

function formatCandidate(candidate: ExternalRecordRef, index: number): string {
  // Relationship-disambiguation context folds into `data` as ordinary
  // entries (3b §3.1), so the candidate's whole field bag — properties and
  // any folded-in connections — renders uniformly.
  return [`[Candidate ${index}]`, formatRecord(candidate.data)].join('\n');
}

/**
 * Decide which candidate (if any) is the same entity as the asserted
 * record. Returns the index into `candidates`, or null to create a
 * new record. Confidence below 0.5 is treated as a decline.
 */
export async function judgeEntityMatch(input: {
  asserted: Record<string, unknown>;
  candidates: ExternalRecordRef[];
  recordType: string;
}): Promise<number | null> {
  if (input.candidates.length === 0) return null;
  if (input.candidates.length === 1) return 0;

  const candidateText = input.candidates
    .map((c, i) => formatCandidate(c, i))
    .join('\n\n');

  let result;
  try {
    result = await execute('tg_entity_match', entityMatchPromptDef, {
      recordType: input.recordType,
      asserted: formatRecord(input.asserted),
      candidates: candidateText,
    });
  } catch (err) {
    logger.warn('[tg_entity_match] judge call failed; declining to merge', {
      recordType: input.recordType,
      candidateCount: input.candidates.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  logger.info('[tg_entity_match] decision', {
    recordType: input.recordType,
    candidateCount: input.candidates.length,
    matchIndex: result.match_index,
    confidence: result.confidence,
    reasoning: result.reasoning,
  });

  if (result.match_index == null) return null;
  if (result.confidence < 0.5) return null;
  if (result.match_index < 0 || result.match_index >= input.candidates.length) {
    return null;
  }
  return result.match_index;
}

/**
 * Engine-side arbitration over an adapter's flat candidate shortlist —
 * the May-2026 entity-resolution split: the adapter searches, the engine
 * arbitrates. One decision procedure, shared by the TG engine's
 * `applyActionPlan` and the movement engine's write step:
 *
 *   0 candidates → null (create)
 *   1 candidate → match it (unambiguous by definition)
 *   N candidates, exactly one all-exact over the held constraints →
 *     match it (strong identity wins over fuzzy noise without burning
 *     an LLM call; exactness computed engine-side, 3b §3.2)
 *   N candidates otherwise → LLM judge over each candidate's `data`.
 *     Refusing would create a new record on top of an already-violated
 *     constraint; the judge picks the best match and logs the situation.
 *
 * Returns the index into `candidates`, or null to create a new record.
 */
export async function arbitrateEntityCandidates(input: {
  asserted: Record<string, unknown>;
  candidates: ExternalRecordRef[];
  recordType: string;
  constraints: UniquenessConstraints;
}): Promise<number | null> {
  if (input.candidates.length === 0) return null;
  if (input.candidates.length === 1) return 0;
  const exactIdxs = input.candidates
    .map((c, i) => (candidateIsAllExact(input.constraints, input.asserted, c.data) ? i : -1))
    .filter((i) => i >= 0);
  if (exactIdxs.length === 1) return exactIdxs[0];
  return judgeEntityMatch({
    asserted: input.asserted,
    candidates: input.candidates,
    recordType: input.recordType,
  });
}
