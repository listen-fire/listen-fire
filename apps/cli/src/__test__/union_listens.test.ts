// A listen through a union (`c-[:Spaces]->-[s:Subjects WHERE …]->-[:Notes]->`,
// where a space's `Subjects` are each a Person or a Company, and each has
// `Notes`) is one listen per member: listen-fire resolves each member's
// heads from the same walk, keeping only that member's records, and polls
// each head's notes for that member's listen alone. One note fires the
// function once.
//
// The walk does not type what lands past a union (a Memo or a Remark here),
// so the check holds the fired function's parameter to nothing: `noted`
// says it takes a Memo and is fired with a Remark too.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { lf, lfCommand, project } from './example';

const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');
const MODULE_KIT = join(REPO, 'packages/module-kit');

/** A crm whose one space holds subjects (`subjects.json`: `{ id, type:
 *  'Person' | 'Company', name }`), each a Person or a Company, and notes on
 *  them (`notes.json`: `{ id, on, at }`), polled per subject: a person's
 *  land on a Memo, a company's on a Remark (one edge name off two record
 *  types lands on two, or their arrivals could not be told apart). Each poll
 *  is logged to `polls.log`, its scope the subject it was made for. */
const CRM_MODULE = `const { readFileSync, appendFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { defineModule } = require(${JSON.stringify(join(MODULE_KIT, 'define.ts'))});
const at = (name) => join(__dirname, name);
const held = (name) => (existsSync(at(name)) ? JSON.parse(readFileSync(at(name), 'utf8')) : []);
const field = (id, name) => ({ fieldId: id, displayName: name, kind: 'string', writable: false, required: false });
const notes = (targetTypeId) => ({ fieldId: 'notes', name: 'Notes', targetTypeId, cardinality: 'many', direction: 'outgoing', readable: true, listenable: true, delivery: 'polled', pollEverySeconds: 1, cursor: true, identity: 'Id' });
const subject = (typeId, displayName, noteType) => ({ typeId, displayName, fields: [field('id', 'Id'), field('name', 'Name')], references: [notes(noteType)] });
const note = (typeId, displayName) => ({ typeId, displayName, fields: [field('id', 'Id'), field('text', 'Text')], references: [] });
const types = {
  space: { typeId: 'space', displayName: 'Space', fields: [field('id', 'Id')], references: [
    { fieldId: 'subjects', name: 'Subjects', targetTypeIds: ['person', 'company'], cardinality: 'many', direction: 'outgoing', readable: true, writable: false, membersChange: { relistEverySeconds: 300 } },
  ] },
  person: subject('person', 'Person', 'memo'),
  company: subject('company', 'Company', 'remark'),
  memo: note('memo', 'Memo'),
  remark: note('remark', 'Remark'),
};
const position = (recordType, id, data) => ({ adapterType: 'crm', recordType, identity: { kind: 'stable', recordId: id, data } });
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
      { typeId: 'person', displayName: 'Person', readable: false, writable: false },
      { typeId: 'company', displayName: 'Company', readable: false, writable: false },
      { typeId: 'memo', displayName: 'Memo', readable: false, writable: false },
      { typeId: 'remark', displayName: 'Remark', readable: false, writable: false },
    ],
    describe: async (typeId) => types[String(typeId).toLowerCase()] ?? null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => position.identity.data?.[fieldId] ?? null,
    getRelated: async ({ fieldId }) => {
      if (fieldId === 'Spaces') return [{ position: position('Space', 's1', { Id: 's1' }) }];
      if (fieldId === 'subjects' || fieldId === 'Subjects') return held('subjects.json').map((s) => ({ position: position(s.type, s.id, { Id: s.id, Name: s.name }) }));
      return [];
    },
    createRecord: async () => { throw new Error('read-only'); },
    updateRecord: async () => { throw new Error('read-only'); },
    deleteRecord: async () => { throw new Error('read-only'); },
    poll: async ({ edge, scope, cursor }) => {
      appendFileSync(at('polls.log'), JSON.stringify({ edge, scope }) + '\\n');
      const since = typeof cursor === 'number' ? cursor : 0;
      const all = held('notes.json');
      const recordType = held('subjects.json').find((s) => s.id === scope)?.type === 'Company' ? 'Remark' : 'Memo';
      return {
        arrivals: all.filter((n) => n.on === scope && n.at > since).map((n) => ({ edge: 'Notes', key: scope, identity: n.id, landing: { recordId: n.id, recordType, fields: { Id: n.id, Text: n.id } } })),
        cursor: all.reduce((high, n) => Math.max(high, n.at), since),
      };
    },
  }),
});
`;

const LISTEN = 'listen to c-[:Spaces]->-[s:Subjects WHERE s.Name == "Acme"]->-[:Notes]-> fire noted';

function crmProject(): string {
  const dir = project();
  rmSync(join(dir, 'movements'), { recursive: true });
  mkdirSync(join(dir, 'movements'));
  mkdirSync(join(dir, 'externals/crm'));
  writeFileSync(join(dir, 'externals/crm/lf-external.yaml'), 'name: crm\nmodule: ./crm.ts\n');
  writeFileSync(join(dir, 'externals/crm/crm.ts'), CRM_MODULE);
  writeFileSync(
    join(dir, 'externals/crm/subjects.json'),
    JSON.stringify([
      { id: 'p1', type: 'Person', name: 'Acme' },
      { id: 'c1', type: 'Company', name: 'Acme' },
      { id: 'p2', type: 'Person', name: 'Other' },
    ]),
  );
  notes(dir, []);
  writeFileSync(join(dir, 'movements/subjects.mvt'), `import { crm } from adapters\n\nc = connect crm\n\nfunction noted(n: <c-[:Memo]->>) {\n  fail("noted \${n.Text}")\n}\n\n${LISTEN}\n`);
  return dir;
}

function notes(dir: string, held: Array<{ id: string; on: string; at: number }>): void {
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

/** The subjects each poll of `Notes` was made for. */
function polledSubjects(dir: string): string[] {
  const polls = readFileSync(join(dir, 'externals/crm/polls.log'), 'utf8').split('\n').filter((l) => l !== '');
  return polls.map((l) => JSON.parse(l) as { edge: string; scope?: string }).filter((p) => p.edge === 'Notes').map((p) => p.scope ?? '(none)');
}

test('a listen through a union fires once per arrival, each member watching only its own subjects', () => {
  const dir = crmProject();
  const check = lf(dir, 'check');
  assert.equal(check.code, 0, check.out);
  const armed = drain(dir, 0);
  assert.deepEqual([...new Set(polledSubjects(dir))].sort(), ['c1', 'p1'], `each Acme subject is polled, the other person never: ${armed}`);
  // Each member's listen watches the Acme subject of its own type alone.
  const listed = lf(dir, 'listens');
  const watching = [...listed.out.matchAll(/^subjects:noted .* — watching (\d+ \w+),/gm)].map((line) => line[1]);
  assert.deepEqual(watching.sort(), ['1 Company', '1 Person'], listed.out);
  notes(dir, [
    { id: 'n1', on: 'p1', at: 1 },
    { id: 'n2', on: 'c1', at: 2 },
    { id: 'n3', on: 'p2', at: 3 },
  ]);
  const fired = drain(dir, 61_000);
  assert.deepEqual(noted(fired).sort(), ['n1', 'n2'], fired);
});
