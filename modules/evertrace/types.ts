// Evertrace adapter — the names and ids the rest of the package shares.
//
// The ONE rule (adapters/base.ts): a position's `recordType` is the pretty
// DISPLAY NAME; the `evertrace:*` typeIds below are this adapter's private
// currency and never ride a position.

export const EVERTRACE_ADAPTER_TYPE = 'evertrace';

/** The workspace meta node a movement obtains by constructing the adapter. */
export const EVERTRACE_WORKSPACE_TYPE_ID = 'evertrace:workspace';
export const EVERTRACE_WORKSPACE_DISPLAY_NAME = 'Evertrace';

export const EVERTRACE_SIGNAL_TYPE_ID = 'evertrace:signal';
export const EVERTRACE_SIGNAL_DISPLAY_NAME = 'Signal';

export const EVERTRACE_EXPERIENCE_TYPE_ID = 'evertrace:experience';
export const EVERTRACE_EXPERIENCE_DISPLAY_NAME = 'Experience';

export const EVERTRACE_EDUCATION_TYPE_ID = 'evertrace:education';
export const EVERTRACE_EDUCATION_DISPLAY_NAME = 'Education';

export const EVERTRACE_COMPANY_TYPE_ID = 'evertrace:company';
export const EVERTRACE_COMPANY_DISPLAY_NAME = 'Company';

export const EVERTRACE_SCHOOL_TYPE_ID = 'evertrace:school';
export const EVERTRACE_SCHOOL_DISPLAY_NAME = 'School';

export const EVERTRACE_SEARCH_TYPE_ID = 'evertrace:search';
export const EVERTRACE_SEARCH_DISPLAY_NAME = 'Search';

export const EVERTRACE_LIST_TYPE_ID = 'evertrace:list';
export const EVERTRACE_LIST_DISPLAY_NAME = 'List';

export const EVERTRACE_LIST_ENTRY_TYPE_ID = 'evertrace:list_entry';
export const EVERTRACE_LIST_ENTRY_DISPLAY_NAME = 'List Entry';

// ── Root collections (the meta-node edges an author traverses) ───────────────
// Title Case, plural, and distinct from the record type each yields — the
// convention every other adapter's root collections already follow.

export const EVERTRACE_SIGNALS_COLLECTION = 'Signals';
export const EVERTRACE_SEARCHES_COLLECTION = 'Searches';
export const EVERTRACE_LISTS_COLLECTION = 'Lists';
export const EVERTRACE_COMPANIES_COLLECTION = 'Companies';
export const EVERTRACE_SCHOOLS_COLLECTION = 'Schools';

// ── Edges below the root: read id (private) ↔ natural name (what authors write)

export const EVERTRACE_EXPERIENCES_EDGE = 'experiences';
export const EVERTRACE_EXPERIENCES_EDGE_NAME = 'Experiences';
export const EVERTRACE_EDUCATIONS_EDGE = 'educations';
export const EVERTRACE_EDUCATIONS_EDGE_NAME = 'Educations';
export const EVERTRACE_SIGNAL_LIST_ENTRIES_EDGE = 'signal_list_entries';
export const EVERTRACE_SIGNAL_LIST_ENTRIES_EDGE_NAME = 'List Entries';
export const EVERTRACE_EXPERIENCE_COMPANY_EDGE = 'experience_company';
export const EVERTRACE_EXPERIENCE_COMPANY_EDGE_NAME = 'Company';
export const EVERTRACE_EDUCATION_SCHOOL_EDGE = 'education_school';
export const EVERTRACE_EDUCATION_SCHOOL_EDGE_NAME = 'School';
export const EVERTRACE_SEARCH_SIGNALS_EDGE = 'search_signals';
export const EVERTRACE_SEARCH_SIGNALS_EDGE_NAME = 'Signals';
export const EVERTRACE_LIST_ENTRIES_EDGE = 'list_entries';
export const EVERTRACE_LIST_ENTRIES_EDGE_NAME = 'Entries';
export const EVERTRACE_ENTRY_SIGNAL_EDGE = 'entry_signal';
export const EVERTRACE_ENTRY_SIGNAL_EDGE_NAME = 'Signal';
export const EVERTRACE_ENTRY_LIST_EDGE = 'entry_list';
export const EVERTRACE_ENTRY_LIST_EDGE_NAME = 'List';

// ── Tag vocabularies ────────────────────────────────────────────────────────
// A signal's `taggings` mix two closed vocabularies, and the API filters them
// through two DIFFERENT keys: the kind of event that raised the signal goes to
// `type`, what the person is goes to `profile_tags`. The adapter reads both off
// the one `Tags` field, so these sets are what tells a pushdown which key a
// written value belongs to — and what an author sees as the field's values.

/** The event that raised the signal — Evertrace's `type` filter. */
export const EVERTRACE_SIGNAL_KINDS = [
  'New Company',
  'Stealth Position',
  'Left Position',
  'New Patent',
  'New Grant',
  'New Paper',
] as const;

/** What the person is — Evertrace's `profile_tags` filter. */
export const EVERTRACE_PROFILE_TAGS = [
  'Serial Founder',
  'VC Backed Founder',
  'VC Backed Operator',
  'VC Investor',
  'YC Alumni',
  'Big Tech experience',
  'Big 4 experience',
  'Banking experience',
  'Consulting experience',
] as const;

/** Every value `Tags` is known to take. Open, not closed: Evertrace may tag a
 *  signal from a namespace this adapter has not met. */
export const EVERTRACE_TAG_VALUES: readonly string[] = [
  ...EVERTRACE_SIGNAL_KINDS,
  ...EVERTRACE_PROFILE_TAGS,
];

// ── Listening ───────────────────────────────────────────────────────────────
// Evertrace polls two different things, each its own listenable edge: a signal
// Evertrace has just found (`Signals`) and a signal somebody has just filed
// onto a list (`List Entries`, which lands a `List Entry`). Creation is the
// only "changed since" Evertrace offers on either.

/** How often the host polls either edge unless lf.yaml's `pollEvery` says
 *  otherwise. */
export const EVERTRACE_POLL_EVERY_SECONDS = 300;

/** The root edge a signal added to a list arrives on. It lists nothing: past
 *  entries are walked from their list or their signal. */
export const EVERTRACE_LIST_ENTRIES_COLLECTION = 'List Entries';

/** The saved search a listen on `Signals` names, by its title or its id. */
export const EVERTRACE_SAVED_SEARCH_FIELD = 'Saved Search';
export const EVERTRACE_SAVED_SEARCH_FIELD_ID = 'savedSearch';

/** The list a listen on `List Entries` names (`List Name`, by its name or its
 *  id) and the list an entry is on (`List Id`). */
export const EVERTRACE_LIST_NAME_FIELD = 'List Name';
export const EVERTRACE_LIST_NAME_FIELD_ID = 'listName';
/** The owned scalars a saved search and a list are named by: only Evertrace
 *  can say what a search matches or which list an entry arrived on. */
export const EVERTRACE_SAVED_SEARCH_TYPE = 'EvertraceSavedSearch';
export const EVERTRACE_LIST_NAME_TYPE = 'EvertraceListName';
/** A list entry's identity: its list and its own id, as its record id spells them. */
export const EVERTRACE_LIST_ENTRY_KEY_FIELD_ID = 'entryKey';
export const EVERTRACE_LIST_ID_FIELD = 'List Id';
export const EVERTRACE_LIST_ID_FIELD_ID = 'listId';

/**
 * The opaque cursor a poll hands back. Creation is the one "changed since"
 * mark Evertrace offers, so each edge's cursor is the newest `createdAt`
 * already delivered, in epoch milliseconds. Absent is an edge this listen has
 * never polled: the first poll sets it and delivers nothing.
 */
export interface EvertraceCheckpoint {
  createdAfter?: number;
}

/**
 * A list entry's identity in Evertrace IS the pair (list, entry): every one of
 * its endpoints is `/lists/{listId}/entries/{entryId}`, and there is no lookup
 * by entry id alone. `DeleteInput` / `UpdateInput` carry only an `externalId`,
 * so the pair travels as one string through that seam. Encoded and decoded
 * here, in one place, so no call site re-invents the separator.
 */
export function encodeListEntryId(input: { listId: string; entryId: string }): string {
  return `${input.listId}:${input.entryId}`;
}

/** The inverse of {@link encodeListEntryId}. Splits at the FIRST separator —
 *  undefined when the value is not a pair. */
export function decodeListEntryId(
  externalId: string,
): { listId: string; entryId: string } | undefined {
  const at = externalId.indexOf(':');
  if (at <= 0 || at === externalId.length - 1) return undefined;
  return { listId: externalId.slice(0, at), entryId: externalId.slice(at + 1) };
}
