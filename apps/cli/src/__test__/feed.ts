// A polled notes feed module for listen-fire's tests: a module whose manifest
// declares `poll`, installed into a copy of the example project.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { project } from './example';

const MODULE_KIT = resolve(__dirname, '../../../../packages/module-kit');

export interface Note {
  id: string;
  title: string;
  /** When it last changed: what a poll's checkpoint and cursor pass. */
  at: number;
  /** The note's kind, its `eventType`: `note.added` unless it says. */
  type?: string;
  /** How many times it was edited: its `Edited` field, the version of its
   *  arrivals on `Notes` (0 unless it says). */
  edited?: number;
}

/** A notes feed, polled: `feed.json` is what the provider holds, `polls.log`
 *  the checkpoint each poll was handed, `listeners.log` the listener each poll
 *  named, and `replay` makes it forget the
 *  checkpoint (an overlapping poll's duplicates), `fast` polls it every
 *  second rather than every minute, `unlabelled` leaves its events' kind
 *  unset (a module older than adapter protocol 2.3). Each poll takes 300ms.
 *
 *  Its root `Notes` is listenable (adapter protocol 2.6): polled every
 *  `pollEverySeconds` (60, or 1 when `fast`), with a cursor, each arrival
 *  named by its `Id` and versioned by `Edited`. `edge-polls.log` holds what
 *  each poll of an edge was handed (`{ edge, filter?, scope?, cursor? }`);
 *  `replay` makes it forget the cursor too.
 *  With `nocursor` present `Notes` declares `cursor: false`: every poll lists
 *  all of it. With `takes` present the feed takes `Title ==` on `Notes`: it applies a
 *  filter it is handed and says so (`takenApplied`). */
const FEED_MODULE = `const { readFileSync, appendFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { defineModule } = require(${JSON.stringify(join(MODULE_KIT, 'define.ts'))});
const at = (name) => join(__dirname, name);
const takes = existsSync(at('takes'));
const noCursor = existsSync(at('nocursor'));
const note = {
  typeId: 'note',
  displayName: 'Note',
  fields: [
    { fieldId: 'id', displayName: 'Id', kind: 'string', writable: false, required: false },
    { fieldId: 'title', displayName: 'Title', kind: 'string', writable: false, required: false, ...(takes ? { capability: { filterOperators: ['eq'] } } : {}) },
    { fieldId: 'edited', displayName: 'Edited', kind: 'number', writable: false, required: false },
  ],
  references: [],
};
const notesOf = (since) => JSON.parse(readFileSync(at('feed.json'), 'utf8')).filter((n) => n.at > since);
// The one filter the feed takes: Title == a literal; every other one is left to the host.
const titleIs = (filter) =>
  filter?.type === 'compare' && filter.op === 'eq' && filter.left?.type === 'property' && filter.left.propertyTypeId === 'Title' && filter.right?.type === 'static' ? filter.right.value : undefined;
const pollEdge = async ({ edge, filter, scope, cursor }) => {
  appendFileSync(at('edge-polls.log'), JSON.stringify({ edge, ...(filter === undefined ? {} : { filter }), ...(scope === undefined ? {} : { scope }), ...(cursor === undefined ? {} : { cursor }) }) + '\\n');
  await new Promise((done) => setTimeout(done, 300));
  const since = existsSync(at('replay')) || typeof cursor !== 'number' ? 0 : cursor;
  const title = takes ? titleIs(filter) : undefined;
  const notes = notesOf(since).filter((n) => title === undefined || n.title === title);
  return {
    arrivals: notes.map((n) => ({
      edge: 'Notes',
      identity: n.id,
      version: String(n.edited ?? 0),
      landing: { recordId: n.id, recordType: 'Note', fields: { Id: n.id, Title: n.title, Edited: n.edited ?? 0 } },
      ...(title === undefined ? {} : { takenApplied: true }),
    })),
    ...(noCursor ? {} : { cursor: JSON.parse(readFileSync(at('feed.json'), 'utf8')).reduce((high, n) => Math.max(high, n.at), since) }),
  };
};
module.exports = defineModule({
  kind: 'adapter',
  name: 'feed',
  credentials: [],
  protocolMinor: 6,
  manifest: { adapterType: 'feed', displayName: 'Feed', supportedTriggers: ['poll'], methods: [], webhookEventTypeId: 'note', subscribableEvents: ['note.added', 'note.removed'] },
  poll: { intervalSeconds: existsSync(at('fast')) ? 1 : 60 },
  create: () => ({
    adapterType: 'feed',
    supportedTriggers: ['poll'],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [
      {
        typeId: 'note',
        displayName: 'Note',
        readable: false,
        writable: false,
        fires: true,
        listenable: true,
        collectionName: 'Notes',
        delivery: 'polled',
        pollEverySeconds: existsSync(at('fast')) ? 1 : 60,
        cursor: !noCursor,
        identity: 'Id',
        version: 'Edited',
        ...(takes ? { capability: { filter: 'native', supportsLimit: false } } : {}),
      },
    ],
    describe: async (typeId) => (typeId === 'note' || typeId === 'Note' ? note : null),
    resolveEntity: async () => ({ candidates: [] }),
    // A polled event's payload holds its fields by id; a landing's, by name.
    getFieldValue: async ({ position, fieldId }) => {
      const data = position.identity.data ?? {};
      const name = note.fields.find((f) => f.fieldId === fieldId.toLowerCase())?.displayName;
      return data[fieldId.toLowerCase()] ?? (name === undefined ? undefined : data[name]) ?? null;
    },
    getRelated: async () => [],
    createRecord: async () => { throw new Error('read-only'); },
    updateRecord: async () => { throw new Error('read-only'); },
    deleteRecord: async () => { throw new Error('read-only'); },
    poll: async (input) => {
      if ('edge' in input) return pollEdge(input);
      const { checkpoint, movementId } = input;
      appendFileSync(at('polls.log'), JSON.stringify(checkpoint ?? null) + '\\n');
      appendFileSync(at('listeners.log'), JSON.stringify(movementId ?? null) + '\\n');
      await new Promise((done) => setTimeout(done, 300));
      const since = existsSync(at('replay')) || typeof checkpoint !== 'number' ? 0 : checkpoint;
      const notes = notesOf(since);
      return {
        events: notes.map((n) => ({ payload: n, externalId: n.id, idempotencyKey: n.id, ...(existsSync(at('unlabelled')) ? {} : { eventType: n.type ?? 'note.added' }) })),
        checkpoint: notes.reduce((high, n) => Math.max(high, n.at), since),
      };
    },
  }),
});
`;

/** The example project with only the notes movement, on the feed. */
export function feedProject(listen?: string): string {
  const dir = project();
  rmSync(join(dir, 'movements'), { recursive: true });
  mkdirSync(join(dir, 'movements'));
  return withFeed(dir, listen);
}

/** `dir` with the feed module installed and a movement listening to it
 *  (`notes:seen`, which fails naming each note it is fired with; `listen` is the listen statement). */
export function withFeed(dir: string, listen = 'listen to f fire seen'): string {
  mkdirSync(join(dir, 'externals/feed'));
  writeFileSync(join(dir, 'externals/feed/lf-external.yaml'), 'name: feed\nmodule: ./feed.ts\n');
  writeFileSync(join(dir, 'externals/feed/feed.ts'), FEED_MODULE);
  feed(dir, [
    { id: 'n1', title: 'First', at: 1 },
    { id: 'n2', title: 'Second', at: 2 },
  ]);
  writeFileSync(
    join(dir, 'movements/notes.mvt'),
    `import { feed } from adapters\n\nf = connect feed\n\nfunction seen(n: <f-[:Note]->>) {\n  fail("seen \${n.Title}")\n}\n\n${listen}\n`,
  );
  return dir;
}

export function feed(dir: string, notes: Note[]): void {
  writeFileSync(join(dir, 'externals/feed/feed.json'), JSON.stringify(notes));
}

/** The checkpoint each poll so far was handed. */
export function polls(dir: string): unknown[] {
  return logged(dir, 'polls.log');
}

/** What each poll of an edge so far was handed. */
export function edgePolls(dir: string): unknown[] {
  return logged(dir, 'edge-polls.log');
}

/** The listener each poll so far named (`movementId`). */
export function listeners(dir: string): unknown[] {
  return logged(dir, 'listeners.log');
}

function logged(dir: string, name: string): unknown[] {
  const log = join(dir, 'externals/feed', name);
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as unknown);
}

