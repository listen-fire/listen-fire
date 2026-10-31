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
  /** The board it is pinned to: it arrives on that board's `Notes` too. */
  board?: string;
}

/** A board notes are pinned to: a root `Boards` member. */
export interface Board {
  id: string;
  name: string;
  /** When it last changed: a poll of `Boards` passes it as its cursor. */
  at?: number;
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
 *  filter it is handed and says so (`takenApplied`).
 *  Its root `Boards` (`boards.json`) is cheap to list, re-listed every 300
 *  seconds; with `pushedboards` present it is listenable and polled instead,
 *  and declares `parentChanges: pushed`; with `staticboards` present it is
 *  not cheap to list and declares neither, and a board's `Notes` are pushed
 *  per board (`delivery: scope`). A board's `Notes` are polled per board, its id the
 *  poll's `scope`: the notes pinned to it (`board`), each arrival naming
 *  the board as its `key` unless `nokey` is present. With `based` present a
 *  connection is constructed in a base (`connect feed { base: "…" }`), which
 *  changes nothing it lists. */
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
const pushedBoards = existsSync(at('pushedboards'));
const staticBoards = existsSync(at('staticboards'));
const keyless = existsSync(at('nokey'));
const every = existsSync(at('fast')) ? 1 : 60;
const notesOf = (since) => JSON.parse(readFileSync(at('feed.json'), 'utf8')).filter((n) => n.at > since);
const boardsOf = () => (existsSync(at('boards.json')) ? JSON.parse(readFileSync(at('boards.json'), 'utf8')) : []);
const boardPosition = (b) => ({ adapterType: 'feed', recordType: 'Board', identity: { kind: 'stable', recordId: b.id, data: { Id: b.id, Name: b.name } } });
// A board's notes are polled per board (\`delivery: polled\`, a poll's \`scope\` the board's id).
const board = {
  typeId: 'board',
  displayName: 'Board',
  fields: [
    { fieldId: 'id', displayName: 'Id', kind: 'string', writable: false, required: false },
    { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false },
  ],
  references: [
    staticBoards
      ? { fieldId: 'notes', name: 'Notes', targetTypeId: 'note', cardinality: 'many', direction: 'outgoing', readable: false, listenable: true, delivery: 'scope', identity: 'Id', version: 'Edited' }
      : { fieldId: 'notes', name: 'Notes', targetTypeId: 'note', cardinality: 'many', direction: 'outgoing', readable: false, listenable: true, delivery: 'polled', pollEverySeconds: every, cursor: true, identity: 'Id', version: 'Edited' },
  ],
};
// The one filter the feed takes: Title == a literal; every other one is left to the host.
const titleIs = (filter) =>
  filter?.type === 'compare' && filter.op === 'eq' && filter.left?.type === 'property' && filter.left.propertyTypeId === 'Title' && filter.right?.type === 'static' ? filter.right.value : undefined;
const pollEdge = async ({ edge, filter, scope, cursor }) => {
  appendFileSync(at('edge-polls.log'), JSON.stringify({ edge, ...(filter === undefined ? {} : { filter }), ...(scope === undefined ? {} : { scope }), ...(cursor === undefined ? {} : { cursor }) }) + '\\n');
  await new Promise((done) => setTimeout(done, 300));
  const since = existsSync(at('replay')) || typeof cursor !== 'number' ? 0 : cursor;
  const title = takes ? titleIs(filter) : undefined;
  if (edge === 'Boards') {
    const boards = boardsOf().filter((b) => (b.at ?? 0) > since);
    return {
      arrivals: boards.map((b) => ({ edge: 'Boards', identity: b.id, landing: { recordId: b.id, recordType: 'Board', fields: { Id: b.id, Name: b.name } } })),
      cursor: boardsOf().reduce((high, b) => Math.max(high, b.at ?? 0), since),
    };
  }
  const notes = notesOf(since).filter((n) => (title === undefined || n.title === title) && (scope === undefined || n.board === scope));
  return {
    arrivals: notes.map((n) => ({
      edge: 'Notes',
      ...(scope === undefined || keyless ? {} : { key: scope }),
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
  manifest: {
    adapterType: 'feed',
    displayName: 'Feed',
    supportedTriggers: ['poll'],
    methods: [],
    webhookEventTypeId: 'note',
    subscribableEvents: ['note.added', 'note.removed'],
    ...(existsSync(at('based')) ? { positionArgs: [{ name: 'base', optionsFrom: 'Board', label: 'Base' }] } : {}),
  },
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
      // Cheap to list: re-listed every 5 minutes, or, with \`pushedboards\`, re-listed on each
      // arrival on \`Boards\` (polled every \`pollEverySeconds\`); with \`staticboards\`, neither.
      {
        typeId: 'board',
        displayName: 'Board',
        collectionName: 'Boards',
        readable: true,
        writable: false,
        ...(pushedBoards
          ? { cheapToList: true, parentChanges: 'pushed', listenable: true, delivery: 'polled', pollEverySeconds: every, cursor: true, identity: 'Id' }
          : staticBoards
            ? {}
            : { cheapToList: true, relistEverySeconds: 300 }),
      },
    ],
    describe: async (typeId) => (typeId === 'note' || typeId === 'Note' ? note : typeId === 'board' || typeId === 'Board' ? board : null),
    resolveEntity: async () => ({ candidates: [] }),
    // A polled event's payload holds its fields by id; a landing's, by name.
    getFieldValue: async ({ position, fieldId }) => {
      const data = position.identity.data ?? {};
      const fields = position.recordType === 'Board' || position.recordType === 'board' ? board.fields : note.fields;
      const name = fields.find((f) => f.fieldId === fieldId.toLowerCase())?.displayName;
      return data[fieldId] ?? data[fieldId.toLowerCase()] ?? (name === undefined ? undefined : data[name]) ?? null;
    },
    // Only the boards are listed: \`boards.log\` counts the lists.
    getRelated: async ({ fieldId }) => {
      if (fieldId !== 'Boards') return [];
      appendFileSync(at('boards.log'), '.\\n');
      return boardsOf().map((b) => ({ position: boardPosition(b) }));
    },
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

/** What the provider holds of the boards notes are pinned to. */
export function boards(dir: string, held: Board[]): void {
  writeFileSync(join(dir, 'externals/feed/boards.json'), JSON.stringify(held));
}

/** How many times the boards were listed. */
export function boardLists(dir: string): number {
  const log = join(dir, 'externals/feed/boards.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l !== '').length : 0;
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

