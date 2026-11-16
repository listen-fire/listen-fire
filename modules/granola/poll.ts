// Granola's poll of `Meetings` (adapter protocol 2.6): Granola has no
// webhook, so the host polls the edge once for every listen sharing a
// connection and a taken filter. Each note new or changed since the
// high-water `updated_at` arrives once, versioned by that `updated_at`; a
// note with neither a summary nor a transcript is not one yet. The module
// applies the taken filter itself over the note it fetched, so every arrival
// says `takenApplied`.

import { holds, takenComparisons, type PollEdgeAnswer, type PollEdgeInput } from 'module-kit';

import { noteHasContent, normalizeNote, type GranolaClient } from './api_client';
import { noteFields } from './adapter';
import { GRANOLA_MEETINGS_COLLECTION, GRANOLA_NOTE_DISPLAY_NAME, type GranolaCheckpoint } from './types';

/** An arrival that landed (the gone kind is never a poll's). */
type Arrival = Extract<PollEdgeAnswer['arrivals'][number], { landing: unknown }>;

function parseCheckpoint(cursor: unknown): GranolaCheckpoint | undefined {
  if (typeof cursor !== 'object' || cursor === null) return undefined;
  const updatedAfter: unknown = Reflect.get(cursor, 'updatedAfter');
  return typeof updatedAfter === 'string' ? { updatedAfter } : undefined;
}

export async function pollGranola(client: GranolaClient, input: PollEdgeInput): Promise<PollEdgeAnswer> {
  if (input.edge !== GRANOLA_MEETINGS_COLLECTION) {
    throw new Error(`@lf/granola: no edge ${input.edge} to poll (its listenable edge is ${GRANOLA_MEETINGS_COLLECTION})`);
  }
  const checkpoint = parseCheckpoint(input.cursor);
  const taken = takenComparisons(input.filter);

  // First poll: set the mark to now and deliver nothing. A live listen hears
  // meetings from go-live onward — it never backfills the whole archive
  // (which would flood the movement on connect). Past meetings stay
  // reachable by walking `Meetings`.
  if (checkpoint === undefined) {
    return { arrivals: [], cursor: { updatedAfter: new Date().toISOString() } };
  }

  const summaries = await client.listAllNotes(checkpoint.updatedAfter);
  const arrivals: Arrival[] = [];
  let maxUpdatedAt = checkpoint.updatedAfter;
  for (const summary of summaries) {
    // The mark moves over every note seen, delivered or not, so none is
    // listed again next poll.
    if (summary.updated_at > maxUpdatedAt) maxUpdatedAt = summary.updated_at;
    const note = await client.getNote(summary.id);
    if (!noteHasContent(note)) continue;
    const record = normalizeNote(note);
    const fields: Record<string, unknown> = { ...record, ...noteFields(record) };
    if (!(taken ?? []).every((comparison) => holds(fields[comparison.field], comparison))) continue;
    arrivals.push({
      edge: GRANOLA_MEETINGS_COLLECTION,
      identity: note.id,
      version: note.updated_at,
      landing: { recordId: note.id, recordType: GRANOLA_NOTE_DISPLAY_NAME, fields },
      occurredAt: note.updated_at,
      ...(taken !== undefined ? { takenApplied: true } : {}),
    });
  }
  // Oldest first — a movement handles meetings in the order they changed.
  arrivals.sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''));
  return { arrivals, cursor: { updatedAfter: maxUpdatedAt } };
}
