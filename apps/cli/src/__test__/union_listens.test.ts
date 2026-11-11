// A listen through a union (`c-[:Spaces]->-[s:Subjects WHERE …]->…`, where a
// space's `Subjects` are each a Person or a Company) is one listen, watched
// once per member: listen-fire resolves each member's heads, keeping only that
// member's records, and polls under each head by its member's edge.
// Everything a person sees of it is one listen: one line in `listen-fire
// listens`, one pipeline naming its receipts and its state, one pause, one
// Arrival Not Judged, one replay target. One note fires the function once.
// `Notes` is announced and never listed, as the edge a listen ends on
// commonly is.
//
// A Person's and a Company's own `Notes` land on a Memo and a Remark, so a
// listen ending on them fires a function whose parameter accepts both, written
// as TypeScript's `Memo | Remark` is: `<c-[:Memo]-> | c-[:Remark]->>`. Each
// subject's `Owner` is a User whose `Notes` land on a Note, so a listen
// through the union to an owner's notes fires a function that takes a Note.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { lf, lfCommand, project } from './example';

const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');
const MODULE_KIT = join(REPO, 'packages/module-kit');

/** A crm whose one space holds subjects (`subjects.json`: `{ id, type:
 *  'Person' | 'Company', name, owner }`), each a Person or a Company owned by
 *  a User, and notes (`notes.json`: `{ id, on, at, untyped? }`) on a subject
 *  or a user, polled per record they are on: a person's land on a Memo, a
 *  company's on a Remark (one edge name off two record types lands on two, or
 *  their arrivals could not be told apart), a user's on a Note. Each poll is
 *  logged to `polls.log`, its scope the record it was made for; a note
 *  `untyped` arrives naming no record type. */
const CRM_MODULE = `const { readFileSync, appendFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { defineModule } = require(${JSON.stringify(join(MODULE_KIT, 'define.ts'))});
const at = (name) => join(__dirname, name);
const held = (name) => (existsSync(at(name)) ? JSON.parse(readFileSync(at(name), 'utf8')) : []);
const field = (id, name) => ({ fieldId: id, displayName: name, kind: 'string', writable: false, required: false });
const notes = (targetTypeId) => ({ fieldId: 'notes', name: 'Notes', targetTypeId, cardinality: 'many', direction: 'outgoing', readable: false, listenable: true, delivery: 'polled', pollEverySeconds: 1, cursor: true, identity: 'Id' });
const owner = { fieldId: 'owner', name: 'Owner', targetTypeId: 'user', cardinality: 'one', direction: 'outgoing', readable: true, writable: false };
const subject = (typeId, displayName, noteType) => ({ typeId, displayName, fields: [field('id', 'Id'), field('name', 'Name')], references: [notes(noteType), owner] });
const note = (typeId, displayName) => ({ typeId, displayName, fields: [field('id', 'Id'), field('text', 'Text')], references: [] });
const types = {
  space: { typeId: 'space', displayName: 'Space', fields: [field('id', 'Id')], references: [
    { fieldId: 'subjects', name: 'Subjects', targetTypeIds: ['person', 'company'], cardinality: 'many', direction: 'outgoing', readable: true, writable: false, membersChange: { relistEverySeconds: 300 } },
  ] },
  person: subject('person', 'Person', 'memo'),
  company: subject('company', 'Company', 'remark'),
  user: { typeId: 'user', displayName: 'User', fields: [field('id', 'Id')], references: [notes('note')] },
  memo: note('memo', 'Memo'),
  remark: note('remark', 'Remark'),
  note: note('note', 'Note'),
};
const position = (recordType, id, data) => ({ adapterType: 'crm', recordType, identity: { kind: 'stable', recordId: id, data } });
const subjects = () => held('subjects.json');
module.exports = defineModule({
  kind: 'adapter',
  name: 'crm',
  credentials: [],
  protocolMinor: 6,
  manifest: { adapterType: 'crm', displayName: 'Crm', supportedTriggers: ['poll'], methods: [] },
  poll: { intervalSeconds: 1 },
  create: () => ({
    adapterType: 'crm',
    supportedTriggers: ['poll'],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [
      { typeId: 'space', displayName: 'Space', collectionName: 'Spaces', readable: true, writable: false, membersChange: { relistEverySeconds: 300 } },
      ...['person', 'company', 'user', 'memo', 'remark', 'note'].map((typeId) => ({ typeId, displayName: types[typeId].displayName, readable: false, writable: false })),
    ],
    describe: async (typeId) => types[String(typeId).toLowerCase()] ?? null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => position.identity.data?.[fieldId] ?? null,
    getRelated: async ({ position: from, fieldId }) => {
      if (fieldId === 'Spaces') return [{ position: position('Space', 's1', { Id: 's1' }) }];
      if (fieldId === 'subjects' || fieldId === 'Subjects') return subjects().map((s) => ({ position: position(s.type, s.id, { Id: s.id, Name: s.name }) }));
      if (fieldId === 'owner' || fieldId === 'Owner') {
        const owned = subjects().find((s) => s.id === from.identity.recordId);
        return owned === undefined ? [] : [{ position: position('User', owned.owner, { Id: owned.owner }) }];
      }
      return [];
    },
    createRecord: async () => { throw new Error('read-only'); },
    updateRecord: async () => { throw new Error('read-only'); },
    deleteRecord: async () => { throw new Error('read-only'); },
    poll: async ({ edge, scope, cursor }) => {
      appendFileSync(at('polls.log'), JSON.stringify({ edge, scope }) + '\\n');
      const since = typeof cursor === 'number' ? cursor : 0;
      const all = held('notes.json');
      const on = subjects().find((s) => s.id === scope)?.type;
      const recordType = on === 'Company' ? 'Remark' : on === 'Person' ? 'Memo' : 'Note';
      return {
        arrivals: all.filter((n) => n.on === scope && n.at > since).map((n) => ({ edge: 'Notes', key: scope, identity: n.id, landing: { recordId: n.id, ...(n.untyped ? {} : { recordType }), fields: { Id: n.id, Text: n.id } } })),
        cursor: all.reduce((high, n) => Math.max(high, n.at), since),
      };
    },
  }),
});
`;

const ACME = 'c-[:Spaces]->-[s:Subjects WHERE s.Name == "Acme"]->';

/** The project, `noted` taking `n: <param>` and fired by `listen to
 *  <path> fire noted`. */
function crmProject(param: string, path = `${ACME}-[:Notes]->`): string {
  const dir = project();
  rmSync(join(dir, 'movements'), { recursive: true });
  mkdirSync(join(dir, 'movements'));
  mkdirSync(join(dir, 'externals/crm'));
  writeFileSync(join(dir, 'externals/crm/lf-external.yaml'), 'name: crm\nmodule: ./crm.ts\n');
  writeFileSync(join(dir, 'externals/crm/crm.ts'), CRM_MODULE);
  writeFileSync(
    join(dir, 'externals/crm/subjects.json'),
    JSON.stringify([
      { id: 'p1', type: 'Person', name: 'Acme', owner: 'u1' },
      { id: 'c1', type: 'Company', name: 'Acme', owner: 'u2' },
      { id: 'p2', type: 'Person', name: 'Other', owner: 'u3' },
    ]),
  );
  notes(dir, []);
  writeFileSync(join(dir, 'movements/subjects.mvt'), `import { crm } from adapters\n\nc = connect crm\n\nfunction noted(n: ${param}) {\n  fail("noted \${n.Text}")\n}\n\nlisten to ${path} fire noted\n`);
  return dir;
}

/** The project of a listen through the union to each Acme subject's owner's
 *  notes, which land on a Note. */
const ownersProject = () => crmProject('<c-[:Note]->>', `${ACME}-[:Owner]->-[:Notes]->`);

function notes(dir: string, held: Array<{ id: string; on: string; at: number; untyped?: boolean }>): void {
  writeFileSync(join(dir, 'externals/crm/notes.json'), JSON.stringify(held));
}

function drain(dir: string, aheadMs: number): string {
  const run = spawnSync(...lfCommand(['drain', '--until-idle']), { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', LF_CLOCK_AHEAD_MS: String(aheadMs) } });
  return `${run.stdout}${run.stderr}`;
}

/** The notes `noted` was fired with, as a drain's output says. */
function noted(out: string): string[] {
  return [...out.matchAll(/MOVENG_ERROR: noted (\S+)/g)].map((said) => said[1]);
}

/** The records each poll of `Notes` was made for. */
function polledScopes(dir: string): string[] {
  const polls = readFileSync(join(dir, 'externals/crm/polls.log'), 'utf8').split('\n').filter((l) => l !== '');
  return polls.map((l) => JSON.parse(l) as { edge: string; scope?: string }).filter((p) => p.edge === 'Notes').map((p) => p.scope ?? '(none)');
}

/** Each row `sql` reads from the project's state file. */
function stateRows<T>(dir: string, sql: string): T[] {
  const db = new DatabaseSync(join(dir, '.lf', 'state.db'));
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

/** The lines `listen-fire listens` says of `subjects:noted`. */
function listensLines(dir: string): string[] {
  const listed = lf(dir, 'listens');
  assert.equal(listed.code, 0, listed.out);
  return listed.out.split('\n').filter((line) => line.startsWith('subjects:noted'));
}

/** The pipelines of `subjects:noted` the state file keeps its state under. */
const statePipelines = (dir: string) => stateRows<{ pipeline: string; state: string }>(dir, "select pipeline, state from listen_state where pipeline like 'listen:subjects:noted:%'");

test("the fired function's parameter is held to what lands under every member", () => {
  const check = lf(crmProject('<c-[:Memo]->>'), 'check');
  assert.notEqual(check.code, 0, check.out);
  assert.match(check.out, /MOV_LISTEN_PARAM_MISMATCH 'noted' takes 'n: <c-\[:Memo\]->>', .* 'c-\[:Spaces\]->-\[:Subjects\]-><Company>-\[:Notes\]->' lands Remark/, check.out);
  assert.equal(check.out.match(/ error /g)?.length, 1, `an announced edge off a union is not write-only: ${check.out}`);
});

test("a listen through a union onto each member's own notes fires a function typed by the union of the landings, once per arrival", () => {
  const dir = crmProject('<c-[:Memo]-> | c-[:Remark]->>');
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const armed = drain(dir, 0);
  assert.deepEqual([...new Set(polledScopes(dir))].sort(), ['c1', 'p1'], `each Acme subject is polled, the other person never: ${armed}`);
  const [line, ...more] = listensLines(dir);
  assert.deepEqual(more, [], 'one line for the one listen');
  assert.match(line, / — watching 1 Company and 1 Person, resolved /, line);
  notes(dir, [
    { id: 'n1', on: 'p1', at: 1 },
    { id: 'n2', on: 'c1', at: 2 },
    { id: 'n3', on: 'p2', at: 3 },
  ]);
  const fired = drain(dir, 61_000);
  assert.deepEqual(noted(fired).sort(), ['n1', 'n2'], fired);
});

test('a listen through a union is one listen: one line, one pipeline, one state, one fire per arrival, each member watching only its own subjects', () => {
  const dir = ownersProject();
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const armed = drain(dir, 0);
  assert.deepEqual([...new Set(polledScopes(dir))].sort(), ['u1', 'u2'], `each Acme subject's owner is polled, the other person's never: ${armed}`);
  const [line, ...more] = listensLines(dir);
  assert.deepEqual(more, [], 'one line for the one listen');
  assert.match(line, /^subjects:noted — c-\[:Spaces\]->-\[s:Subjects WHERE s\.Name == "Acme"\]-><Company \| Person>-\[:Owner\]->-\[:Notes\]-> — unfiltered, resolved, unfiltered, arrival — watching 2 Users, resolved \d+s ago — ok/, line);
  // One state, under the one pipeline: its heads, and each member its own.
  const [state, ...states] = statePipelines(dir);
  assert.deepEqual(states, [], 'one state for the one listen');
  const kept = JSON.parse(state?.state ?? '{}') as { heads: string[]; members?: Array<{ heads: string[] }> };
  assert.deepEqual([kept.heads, kept.members?.map((m) => m.heads)], [['u2', 'u1'], [['u2'], ['u1']]], `the Company member's owner, then the Person member's: ${state?.state}`);

  notes(dir, [
    { id: 'n1', on: 'u1', at: 1 },
    { id: 'n2', on: 'u2', at: 2 },
    { id: 'n3', on: 'u3', at: 3 },
  ]);
  const fired = drain(dir, 61_000);
  assert.deepEqual(noted(fired).sort(), ['n1', 'n2'], `each arrival fires the listen once, the other owner's never: ${fired}`);
  // Its receipts are named by the pipeline its state is kept under.
  const receipts = stateRows<{ listen: string }>(dir, "select distinct listen from event_receipt where listen like 'listen:subjects:noted:%'");
  assert.deepEqual(receipts.map((r) => r.listen), [state?.pipeline], JSON.stringify(receipts));

  // Paused, it is paused once, and resumed once.
  stateRows(dir, `update listen_state set state = json_set(state, '$.paused', 'LISTEN_LOOP: held for the test') where pipeline = '${state?.pipeline}' returning pipeline`);
  const [paused, ...pausedMore] = listensLines(dir);
  assert.deepEqual(pausedMore, []);
  assert.match(paused, / — paused: LISTEN_LOOP: held for the test;/, paused);
  const resumed = lf(dir, 'listens', 'resume', 'subjects:noted');
  assert.equal(resumed.code, 0, resumed.out);
  assert.deepEqual(resumed.out.trim().split('\n'), ['subjects:noted: resumed; it fires again'], resumed.out);
});

test('an arrival a listen through a union cannot judge is one Arrival Not Judged of the one listen, which a replay puts through it again', () => {
  const dir = ownersProject();
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  drain(dir, 0);
  notes(dir, [{ id: 'n9', on: 'u1', at: 9, untyped: true }]);
  const out = drain(dir, 61_000);
  assert.deepEqual(noted(out), [], out);
  // A poll keeps the fact, one, naming the one listen, and runs nothing.
  const [state] = statePipelines(dir);
  const facts = stateRows<{ pipeline: string; delivery_id: string; reason: string }>(dir, 'select pipeline, delivery_id, reason from arrival_unjudged');
  assert.deepEqual(
    facts.map((fact) => [fact.pipeline, fact.reason]),
    [[state?.pipeline, "the arrival crm reported on Notes does not say its record type, so it cannot be told from another record type's Notes (this listen's lands on Note)"]],
    'one fact, naming the one listen',
  );

  const replayed = lf(dir, 'listens', 'replay', 'subjects:noted', '--delivery', facts[0]?.delivery_id ?? '');
  assert.equal(replayed.code, 1, replayed.out);
  assert.equal(replayed.out.match(/cannot be judged/g)?.length, 1, replayed.out);
  const again = stateRows<{ pipeline: string }>(dir, 'select pipeline from arrival_unjudged');
  assert.deepEqual([...new Set(again.map((fact) => fact.pipeline))], [state?.pipeline], 'the replay was judged by the one listen alone');
});
