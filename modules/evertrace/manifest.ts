// Evertrace's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Evertrace without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import {
  EVERTRACE_ADAPTER_TYPE,
  EVERTRACE_LIST_ENTRIES_COLLECTION,
  EVERTRACE_LIST_ENTRY_DISPLAY_NAME,
  EVERTRACE_LIST_NAME_FIELD,
  EVERTRACE_SAVED_SEARCH_FIELD,
  EVERTRACE_SIGNALS_COLLECTION,
  EVERTRACE_SIGNAL_DISPLAY_NAME,
} from './types';

const EVERTRACE_HANDBOOK_CONTENT = `Evertrace watches public profiles and raises a **signal** when someone has just changed in a way worth knowing about — a new company, a stealth position, a departure, a new patent, grant or paper. Three surfaces: pull signals it has already found, react to new ones, and keep the saved searches and curated lists the workspace works from.

### signals — pulling what Evertrace already found

\`\`\`
since = Date.addDays(@current_date, -30)
evertrace-[s:Signals WHERE s.Score >= 8 AND s.\`Discovered At\` >= since]->
\`\`\`

There is no default time window: an unbounded walk covers the whole corpus, so give the WHERE a \`Discovered At\` lower bound and a \`Score\` floor.

Evertrace takes part of the WHERE itself and the rest is applied to what comes back, so the result is the same either way — only the amount fetched changes. What reaches Evertrace: \`Name\` (a partial match), \`Score\` (a floor), \`Country\`, \`City\`, \`Region\`, \`Gender\`, \`Age\`, \`Tags\`, and \`Source\`. \`Discovered At\` narrows what comes back. \`Age\` is a bucket over there — "Below 25", "25 to 29", through "Above 49". \`Tags\` carries two vocabularies: what the person is ("YC Alumni", "Big Tech experience", "Banking experience") and which event raised the signal ("New Company", "Stealth Position", "Left Position", "New Patent", "New Grant", "New Paper"). A WHERE naming values from one of them reaches Evertrace; one mixing both is applied to what comes back.

Below a signal, \`Experiences\` and \`Educations\` are the rows of the person's profile, each resolving one hop further to the \`Company\` or \`School\` Evertrace matched it to, when it matched one.

### listening — being told about new ones

\`\`\`
listen to evertrace-[s:Signals WHERE s.\`Saved Search\` == "Stealth in Europe" AND s.Score >= 8]-> fire triage
\`\`\`

A listen on \`Signals\` fires once per signal created since the last look, five minutes or so behind (\`pollEvery\` in lf.yaml changes the five minutes for the connection). The FIRST look sets the mark and delivers nothing, so going live never replays the back catalogue — walk \`Signals\` when you want history. \`Saved Search\` names a saved search by its title or its id and narrows delivery to what that search matches; a date bound inside that search does not apply — the mark is what bounds delivery. Any other field of the signal narrows too, once the signal arrives. Listens on one connection with the same WHERE share one poll. A change to a signal that already exists does not fire — only a new one does.

### listening — a signal added to a list

\`\`\`
listen to evertrace-[e:\`List Entries\` WHERE e.\`List Name\` == "Pipeline"]-> fire file_it
\`\`\`

What arrives is the entry rather than the signal: \`Signal\` is the person, \`List\` is the list they went onto, and \`Added At\` is when. \`List Name\` names one list by its name or its id; leave it out and every list in the workspace delivers. The first look sets the mark and delivers nothing here too. Removing an entry and putting it back delivers again — that is a new entry.

### lists — filing a signal

A list owns its entries, so an entry lives under its list, and a signal's \`List Entries\` is that same membership seen from the other end. Both ends are required, so filing names them together:

\`\`\`
write (list-[:Entries]->, signal-[:\`List Entries\`]->) { }
\`\`\`

Adding is idempotent on the pair, so a repeat run never doubles a member. \`delete\` removes an entry. \`Lists\` and \`Searches\` are creatable, renameable and removable at the root; writing a search's \`Filters\` replaces the whole set rather than merging into it.

### lists — reading what is on one

\`\`\`
since = Date.addDays(@current_date, -7)
list-[e:Entries WHERE e.\`Added At\` >= since ORDER BY e.\`Added At\` DESC LIMIT 5]-> {
  …
}
\`\`\`

\`Added At\` is when the signal went onto the list, and it is the one thing Evertrace sorts entries by. Every other \`WHERE\` and \`ORDER BY\` runs over the list's entries once they arrive — the list is what bounds them, so a \`filter\` that calls \`ai\` over them is allowed here. A signal's \`List Entries\` reads the same memberships from the other end, and takes the same bracket.

Entries come back oldest first, so \`first\`, \`List.last\` and a bare \`LIMIT\` read them with no \`ORDER BY\`:

\`\`\`
oldest = first(list-[e:Entries]->)
Message: "Longest on the list: \${oldest-[s:Signal]->.Name}"
\`\`\`

A saved search's \`Signals\` takes the same bracket, and its own filters are what bound it — there is no order to lean on, so an \`ORDER BY\` says which one you mean.

### screening and viewing — facts about a signal

Marking a signal screened or viewed is a change to the signal itself, not a separate record:

\`\`\`
write signal { Screened: true }
\`\`\`

Evertrace has no un-view, so \`Viewed: false\` is refused; \`Screened: false\` does un-screen.

### what is deliberately not here

CSV exports, duplicating a saved search, screening and view counts, every signal sharing one LinkedIn profile, and the city lookup are each one endpoint away and not surfaced — say so rather than working around them.`;

const SIGNALS_BECOME = {
  path: [EVERTRACE_SIGNALS_COLLECTION],
  aliases: ['s'],
  paramFrom: EVERTRACE_SIGNAL_DISPLAY_NAME,
  keys: { search: { hop: 0, field: EVERTRACE_SAVED_SEARCH_FIELD, op: 'eq' as const } },
};

/**
 * Static manifest. Polled source plus a real create/update/delete surface over
 * searches, lists and list memberships — so Evertrace is both a source and a
 * target. Nothing here is SUBSCRIBED to (there is no webhook): the host
 * polls each of the two listenable edges.
 */
export const EVERTRACE_MANIFEST: AdapterManifest = {
  adapterType: EVERTRACE_ADAPTER_TYPE,
  displayName: 'Evertrace',
  website: 'https://www.evertrace.ai',
  category: 'CRM',
  description:
    'Evertrace spots founders before they show up in startup databases — a ' +
    'signal is a person whose profile just triggered a trackable event. Pull ' +
    'signals, run on new ones, and file them into your saved searches and lists.',
  authoringHints:
    'Bound a Signals walk: there is no default lookback, so an unfiltered walk ' +
    'covers the whole corpus. A Score floor and a Discovered At lower bound are ' +
    'pushed to Evertrace; other filters are applied after the fetch. A list entry ' +
    'needs both its list and its signal, so write it along both edges at once. ' +
    'Screened and Viewed are fields on a signal, not separate records, and there ' +
    'is no un-view. A list’s Entries come back oldest first and take a WHERE, an ' +
    'ORDER BY and a LIMIT. A listen on Signals delivers new signals, narrowed by ' +
    'Saved Search; a listen on List Entries delivers each signal added to a ' +
    'list, narrowed by List Name.',
  handbookSection: {
    title: 'Evertrace — signals, saved searches and lists',
    content: EVERTRACE_HANDBOOK_CONTENT,
  },
  triggerExpectation:
    'Two edges. A listen on `Signals` fires once per signal Evertrace created ' +
    'since the last poll, narrowed by Saved Search (a saved search, by title or ' +
    'id). A listen on `List Entries` fires once per signal added to a list ' +
    'since the last poll, narrowed by List Name (by name or id; absent means ' +
    'every list in the workspace). Each edge is polled every five minutes ' +
    '(lf.yaml `pollEvery` changes it) and keeps its own cursor, and the first ' +
    'poll sets it and delivers nothing, so going live never replays the back ' +
    'catalogue. Updates to an existing signal do NOT fire — Evertrace offers ' +
    'no changed-since mark other than creation.',
  supportedTriggers: ['poll'],
  methods: [
    'listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated',
    'readRecord', 'createRecord', 'updateRecord', 'deleteRecord',
  ],
  requiredCredentialType: 'EVERTRACE',
  // A 0.12 `listen to evertrace { search }` is a listen on `Signals` with
  // that WHERE, and `{ events: ["list_entry"], list }` one on `List Entries`
  // (`listen-fire upgrade`). A listen naming both events has no rewrite: write
  // one listen for each edge.
  listenSettingsBecome: {
    ...SIGNALS_BECOME,
    byEvent: {
      signal: SIGNALS_BECOME,
      list_entry: {
        path: [EVERTRACE_LIST_ENTRIES_COLLECTION],
        aliases: ['e'],
        paramFrom: EVERTRACE_LIST_ENTRY_DISPLAY_NAME,
        keys: { list: { hop: 0, field: EVERTRACE_LIST_NAME_FIELD, op: 'eq' } },
      },
    },
  },
  triggerKinds: ['EVERTRACE'],
  vocabulary: {
    // Evertrace's mark: the four leaves of its logo, as one filled path.
    icon: {
      d: 'M12.4857 0.346619H24.0998V11.9566H19.2231C15.5021 11.9566 12.4857 8.94012 12.4857 5.21912V0.346619ZM11.0155 0.346619L6.13883 0.346619C2.41783 0.346619 -0.598633 3.36308 -0.598633 7.08408L-0.598633 11.9566H4.27805C7.99905 11.9566 11.0155 8.94012 11.0155 5.21912V0.346619ZM12.4857 25.0362H24.0998V13.4262H19.2231C15.5021 13.4262 12.4857 16.4427 12.4857 20.1637V25.0362ZM11.0155 25.0362H6.13883C2.41783 25.0362 -0.598633 22.0197 -0.598633 18.2987L-0.598633 13.4262H4.27805C7.99905 13.4262 11.0155 16.4427 11.0155 20.1637V25.0362Z',
      fill: true,
      viewBox: '-0.6 -0.6 25.64 25.64',
    },
    eventPhrase: {
      default: [{ template: 'When Evertrace finds a new signal' }],
    },
  },
};
