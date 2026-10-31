// Granola adapter (read side) — Granola-as-source. Granola is a POLLED source:
// the event production is the module's `poll` (poll.ts), driven by the host.
// This Adapter is the clean read half — `describe` over a
// meeting note + its attendees, field reads, the `Attendees` edge, and the
// summary/transcript as TEXT `#resources`. Source-only: no writes.

import type {
  ActorCandidate,
  ActorIdentity,
  Adapter,
  EdgesFromResult,
  GetFieldValueInput,
  GetRelatedInput,
  RelatedResult,
} from 'movement-engine/public/adapter';
import type { SchemaEntryPoint, SchemaFieldDescriptor, SchemaTypeDescriptor, SourcePosition } from 'movement-engine/public/catalog';
import type { Expression } from 'engine-contracts/expression/expression';
import type { TriggerEvent } from 'engine-contracts';

import {
  ADAPTER_META_TYPE_ID,
  META_RECORD_TYPE,
  makeUnstablePosition,
  positionData,
} from 'movement-engine/public/catalog';
import { BaseAdapter } from 'module-kit/adapter/base';
import { uniformWalk } from 'module-kit/adapter/hop';
import type { GranolaClient } from './api_client';
import { GRANOLA_MANIFEST } from './manifest';
import {
  GRANOLA_ADAPTER_TYPE,
  GRANOLA_ATTENDEES_FIELD,
  GRANOLA_ATTENDEE_TYPE_ID,
  GRANOLA_ATTENDEE_DISPLAY_NAME,
  GRANOLA_MEETINGS_COLLECTION,
  GRANOLA_FOLDERS_FIELD,
  GRANOLA_FOLDERS_FIELD_ID,
  GRANOLA_POLL_EVERY_SECONDS,
  GRANOLA_NOTE_TYPE_ID,
  GRANOLA_NOTE_DISPLAY_NAME,
  GRANOLA_WORKSPACE_TYPE_ID,
  type GranolaNotePayload,
} from './types';

/** Where the adapter and the poll get a credentialed client. */
export type GranolaClientSource = () => Promise<GranolaClient>;

export {
  GRANOLA_ADAPTER_TYPE,
  GRANOLA_NOTE_TYPE_ID,
  GRANOLA_NOTE_DISPLAY_NAME,
  GRANOLA_ATTENDEE_TYPE_ID,
  GRANOLA_ATTENDEE_DISPLAY_NAME,
  GRANOLA_ATTENDEES_FIELD,
  GRANOLA_WORKSPACE_TYPE_ID,
  GRANOLA_MEETINGS_COLLECTION,
};

// The `Meetings` collection has NO default lookback: `granola-[m:Meetings]->`
// with no date WHERE pulls the whole archive (an arbitrary floor is surprising —
// if the query implies the whole archive, that's what it gets). When the hop's
// WHERE carries a date lower bound we push it to the API's `updated_after`; the
// rest of the WHERE the engine post-filters. See `pushDownUpdatedAfter` +
// `listMeetings`.

// Date fields whose lower bound (`>=` / `>`) is SAFE to push to `updated_after`:
// each is always <= a note's `updated_at` (a note can't be updated before it was
// created or before the meeting started), so `updated_after = V` never drops a
// meeting whose `<field> >= V`. `scheduled_end` is deliberately excluded — a
// future meeting's end can exceed `updated_at`, so pushing it would under-fetch.
// Matched by BOTH fieldId and displayName (whichever the hop WHERE carries); a
// miss just widens the fetch — the engine post-filters for correctness either way.
const PUSHABLE_LOWER_BOUND_NAMES = new Set([
  'scheduled_start', 'Meeting Start',
  'created_at', 'Created At',
  'updated_at', 'Updated At',
]);

export class GranolaAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = GRANOLA_ADAPTER_TYPE;
  readonly supportedTriggers = GRANOLA_MANIFEST.supportedTriggers;

  /** `client` hands back a credentialed client per call — the module's from
   *  its context, a test's a fake — and throws, naming why, when there is no
   *  usable credential. Needed only when a movement traverses the `Meetings`
   *  collection (the read-from-records paths read inline position data). */
  constructor(private readonly client: GranolaClientSource) {
    super();
  }

  // ── 1. Schema introspection ────────────────────────────────────────────

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return [
      {
        typeId: GRANOLA_NOTE_TYPE_ID,
        displayName: GRANOLA_NOTE_DISPLAY_NAME,
        writable: false,
        readable: true,
        // The meta-root collection that fans out to PAST meeting notes is
        // named `Meetings` (not `Meeting Note`) so an author traverses
        // `granola-[m:Meetings]-> …` without colliding with the poll-fired
        // note type. The collection still yields `Meeting Note` positions —
        // the engine restamps each landed record to this entry's displayName.
        collectionName: GRANOLA_MEETINGS_COLLECTION,
        // One edge, two promises: past notes can be read, and each note new
        // or changed since the last poll arrives on it.
        listenable: true,
        capability: { filter: 'native', supportsLimit: true },
        delivery: 'polled',
        pollEverySeconds: GRANOLA_POLL_EVERY_SECONDS,
        cursor: true,
        identity: 'Granola Note ID',
        version: 'Updated At',
      },
      // A CHILD type: an attendee is reached through its meeting
      // (`note-[:Attendees]->`), never enumerated from the root — `getRelated`
      // has no meta branch for it, so the root collection `readable: true` used
      // to mint was a read that could only ever return nothing. `readable:
      // false` is the true statement about that one meta edge; the position
      // (and the fields resolving after `-[:Attendees]->`) now derive from
      // REACHABILITY — the entry stays published so the name resolver and
      // `describe` still know the type.
      {
        typeId: GRANOLA_ATTENDEE_TYPE_ID,
        displayName: GRANOLA_ATTENDEE_DISPLAY_NAME,
        writable: false,
        readable: false,
      },
    ];
  }

  /** The workspace: `Meetings` is read for past notes and listened to for
   *  new or changed ones — one edge, two promises. */
  private static readonly ROOT: SchemaTypeDescriptor = {
    typeId: META_RECORD_TYPE,
    displayName: 'Granola Meetings',
    description:
      'The Granola workspace. Walk `Meetings` to pull in PAST meeting notes, or ' +
      'listen on it to be told about new or changed ones.',
    fields: [],
    references: [
      {
        fieldId: GRANOLA_MEETINGS_COLLECTION,
        targetTypeId: GRANOLA_NOTE_TYPE_ID,
        cardinality: 'many',
        direction: 'outgoing',
        name: GRANOLA_MEETINGS_COLLECTION,
        description:
          'Past meeting notes the connected Granola account can see. No default ' +
          'lookback — an unbounded walk covers the whole archive, so give the ' +
          'WHERE a date lower bound (e.g. `Meeting Start` >= a date) to keep it ' +
          'fast; other filters (like `Title`) still scan every note.',
        // The client sorts the fetched archive by `updated_at`, newest first
        // (`client.ts` `listMeetingsSince`), and the hop returns that array.
        sequenced: 'chronological',
        listenable: true,
      },
    ],
  };

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: GRANOLA_ADAPTER_TYPE,
      at: position,
      root: GranolaAdapter.ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    // The meta-root descriptor — the "Granola Meetings" node a constructed
    // instance roots at. Its one outgoing reference is the `Meetings`
    // collection: many past Meeting Notes. (The constructed-movement
    // traversal reads collections off `listEntryPoints`; this descriptor
    // gives author-time / editor introspection the same meta-edge.)
    if (typeRef === ADAPTER_META_TYPE_ID || typeRef === GRANOLA_WORKSPACE_TYPE_ID) {
      return {
        typeId: GRANOLA_WORKSPACE_TYPE_ID,
        displayName: 'Granola Meetings',
        description:
          'The Granola workspace — traverse its `Meetings` to pull in PAST meeting notes ' +
          '(distinct from a live listener, which fires only on new or changed notes).',
        fields: [],
        references: [
          {
            fieldId: GRANOLA_MEETINGS_COLLECTION,
            targetTypeId: GRANOLA_NOTE_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: GRANOLA_MEETINGS_COLLECTION,
            description:
              'Past meeting notes the connected Granola account can see. No default ' +
              'lookback — an unbounded walk covers the whole archive, so give the ' +
              'WHERE a date lower bound (e.g. `Meeting Start` >= a date) to keep it ' +
              'fast; other filters (like `Title`) still scan every note.',
          },
        ],
      };
    }
    const typeId = await this.resolveTypeRef(typeRef);
    if (typeId === GRANOLA_NOTE_TYPE_ID) {
      return {
        typeId: GRANOLA_NOTE_TYPE_ID,
        displayName: GRANOLA_NOTE_DISPLAY_NAME,
        description: 'A Granola meeting note — summary, transcript, attendees.',
        fields: NOTE_FIELDS,
        references: [
          {
            fieldId: GRANOLA_ATTENDEES_FIELD,
            targetTypeId: GRANOLA_ATTENDEE_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: 'Attendees',
            description: 'The people on the call (zero or more).',
          },
        ],
      };
    }
    if (typeId === GRANOLA_ATTENDEE_TYPE_ID) {
      return {
        typeId: GRANOLA_ATTENDEE_TYPE_ID,
        displayName: GRANOLA_ATTENDEE_DISPLAY_NAME,
        description: 'A person who attended the meeting.',
        fields: [
          { fieldId: 'email', displayName: 'Email', kind: 'string', writable: false, required: true, description: 'The attendee\'s email — their identity.' },
          { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false },
        ],
        references: [],
      };
    }
    return null;
  }

  // ── 2. Field-level access ──────────────────────────────────────────────

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    if (input.position.adapterType !== GRANOLA_ADAPTER_TYPE) {
      throw new Error(
        `GranolaAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);
    const data = (positionData(input.position) ?? {}) as Record<string, unknown>;
    return data[fieldId] ?? null;
  }

  // ── 3. Reference traversal (attendees) ─────────────────────────────────
  // The summary and transcript are read explicitly off the note (`Summary` /
  // `Transcript` fields). The source content that fed an extraction is reached
  // off the extracted node (`extractedNode-[:_resources]->`), not the input.

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.position.adapterType !== GRANOLA_ADAPTER_TYPE) {
      throw new Error(
        `GranolaAdapter.getRelated received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    if (input.direction !== 'outgoing') return [];

    // Meta-root → `Meetings` collection: a movement constructed `granola(...)`
    // and is traversing `granola-[m:Meetings]-> { … }` to pull PAST meetings.
    // The collection name crosses verbatim (the meta position carries no type
    // to resolve an edge against), so match it BEFORE the per-type edge
    // resolver (which would drift on the typeless meta position).
    if (input.position.recordType === META_RECORD_TYPE) {
      if (input.fieldId !== GRANOLA_MEETINGS_COLLECTION) return [];
      // The LIMIT travels only when nothing has to be sorted first: Granola's
      // list endpoint takes no sort, so under an ORDER BY the engine orders the
      // whole set and slices it (`GetRelatedInput.limit`).
      const cap = input.orderBy === undefined ? input.limit : undefined;
      return this.listMeetings({
        ...(input.where !== undefined ? { where: input.where } : {}),
        ...(cap !== undefined ? { limit: cap } : {}),
      });
    }

    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    if (edgeId === GRANOLA_ATTENDEES_FIELD) {
      const note = (positionData(input.position) ?? {}) as Partial<GranolaNotePayload>;
      return (note.attendees ?? []).map((attendee) => ({
        position: makeUnstablePosition({
          adapterType: GRANOLA_ADAPTER_TYPE,
          recordType: GRANOLA_ATTENDEE_DISPLAY_NAME,
          data: attendee,
        }),
      }));
    }
    return [];
  }

  /**
   * Pull past meetings for the `Meetings` collection — one `Meeting Note`
   * position per past note (unstable, carrying the normalised payload the
   * Note's `getFieldValue` / `Attendees` edge already read from).
   *
   * Bounding: no default lookback — with no date WHERE this pulls the whole
   * archive (page cap aside). We push down what the API supports: a date lower
   * bound from the hop's WHERE becomes `updated_after` (`pushDownUpdatedAfter`).
   * Everything else the WHERE expresses (an upper bound, an attendee EXISTS, a
   * title match) the engine post-filters over what we return, so the result is
   * exact regardless of what we manage to push. `limit` (the hop's LIMIT, and
   * only when the hop asked for no ordering) caps the hydrated count.
   */
  private async listMeetings(input: { where?: Expression; limit?: number }): Promise<RelatedResult[]> {
    const updatedAfter = pushDownUpdatedAfter(input.where);
    const client = await this.client();
    const notes = await client.listMeetingsSince({
      ...(updatedAfter !== undefined ? { updatedAfter } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    return notes.map((note) => ({
      position: makeUnstablePosition({
        adapterType: GRANOLA_ADAPTER_TYPE,
        recordType: GRANOLA_NOTE_DISPLAY_NAME,
        data: note,
      }),
    }));
  }

  // ── 4. Actor — the note's owner is its originator ──────────────────────

  async getActorCandidates(input: { event: TriggerEvent }): Promise<ActorCandidate[]> {
    const actor = await this.extractActor(input);
    return actor ? [{ identity: actor, source: 'originator' }] : [];
  }

  async extractActor(input: { event: TriggerEvent }): Promise<ActorIdentity | null> {
    const note = (input.event.payload ?? {}) as Partial<GranolaNotePayload>;
    const email = note.note_owner_email;
    if (!email) return null;
    return {
      identifier: email,
      scheme: 'email',
      adapterType: GRANOLA_ADAPTER_TYPE,
      email,
      ...(note.note_owner_name ? { name: note.note_owner_name } : {}),
    };
  }

}

/**
 * The tightest safe `updated_after` we can push from a hop's WHERE: the MAX
 * lower bound (`>=` / `>`) across the pushable date fields
 * (`PUSHABLE_LOWER_BOUND_NAMES`). A meeting matching `scheduled_start >= A` has
 * `updated_at >= scheduled_start >= A`, so `updated_after = A` never drops it;
 * taking the max across several such bounds stays safe and fetches the least.
 * Returns undefined when the WHERE names no pushable lower bound (→ fetch the
 * whole archive). Non-`and` structure (OR, NOT) is not pushed — the engine
 * post-filters it. `right`/`left` operand order is handled both ways.
 */
function pushDownUpdatedAfter(where: Expression | undefined): string | undefined {
  if (where === undefined) return undefined;
  let bound: string | undefined;
  const consider = (fieldExpr: Expression, valueExpr: Expression): void => {
    const field = fieldExpr.type === 'property' ? fieldExpr.propertyTypeId : undefined;
    const value =
      valueExpr.type === 'static' && typeof valueExpr.value === 'string' ? valueExpr.value : undefined;
    if (field === undefined || value === undefined || !PUSHABLE_LOWER_BOUND_NAMES.has(field)) return;
    if (bound === undefined || value > bound) bound = value;
  };
  const visit = (e: Expression): void => {
    if (e.type === 'logical' && e.op === 'and') {
      e.operands.forEach(visit);
      return;
    }
    if (e.type === 'compare' && (e.op === 'gte' || e.op === 'gt')) {
      consider(e.left, e.right); // field >= value
    } else if (e.type === 'compare' && (e.op === 'lte' || e.op === 'lt')) {
      consider(e.right, e.left); // value <= field  ⇒  field >= value
    }
  };
  visit(where);
  return bound;
}

/** A meeting note's fields, as `describe` publishes them. */
const NOTE_FIELDS: SchemaFieldDescriptor[] = [
  { fieldId: 'title', displayName: 'Title', kind: 'string', writable: false, required: true, description: 'The note title (or the calendar event title).' },
  { fieldId: 'summary', displayName: 'Summary', kind: 'string', writable: false, required: false, description: 'The meeting summary (markdown when available).' },
  { fieldId: 'transcript_text', displayName: 'Transcript', kind: 'string', writable: false, required: false, description: 'The full meeting transcript (`[You]/[Speaker]: …` lines), when the note has one.' },
  { fieldId: 'scheduled_start', displayName: 'Meeting Start', kind: 'date', writable: false, required: false, description: 'When the meeting was scheduled to start.' },
  { fieldId: 'scheduled_end', displayName: 'Meeting End', kind: 'date', writable: false, required: false, description: 'When the meeting was scheduled to end.' },
  { fieldId: 'organizer_email', displayName: 'Organizer Email', kind: 'string', writable: false, required: false, description: 'The meeting organizer.' },
  { fieldId: 'folder_names', displayName: 'Folder Names', kind: 'string', writable: false, required: false, description: 'The Granola folders this note belongs to.' },
  { fieldId: GRANOLA_FOLDERS_FIELD_ID, displayName: GRANOLA_FOLDERS_FIELD, kind: 'string', cardinality: 'many', writable: false, required: false, capability: { filterOperators: ['contains'] }, description: 'The folders this note is in, by name, lowercased: `n.Folders CONTAINS "deals"`.' },
  { fieldId: 'note_owner_email', displayName: 'Note Owner Email', kind: 'string', writable: false, required: true, description: 'The Granola user who owns the note.' },
  { fieldId: 'note_owner_name', displayName: 'Note Owner Name', kind: 'string', writable: false, required: false },
  { fieldId: 'created_at', displayName: 'Created At', kind: 'date', writable: false, required: true },
  { fieldId: 'updated_at', displayName: 'Updated At', kind: 'date', writable: false, required: true },
  { fieldId: 'granola_note_id', displayName: 'Granola Note ID', kind: 'string', writable: false, required: true, description: 'The stable Granola note id.' },
];

/** A note's fields by the names a program reads them by, as an arrival's
 *  landing carries them for the host to judge a listen's WHERE. */
export function noteFields(record: object): Record<string, unknown> {
  return Object.fromEntries(NOTE_FIELDS.filter((f) => Reflect.has(record, f.fieldId)).map((f) => [f.displayName, Reflect.get(record, f.fieldId)]));
}
