// A run's walk off a union lands on one of the members' landings, through the
// real binary. A space's `Subjects` are each a Person or a Company; a
// Person's `Notes` land on a Memo (Text, Mood) and a Company's on a Remark
// (Text, Tone). Off `c-[:Spaces]->-[:Subjects]->-[:Notes]->` a run reads
// `Text`, which both have; reading `Mood` is refused by `listen-fire check`
// (0.13 checked it clean) until it is narrowed: the Subject to a Person, or
// the note itself to a Memo with `is` (a landing, a union parameter, a
// conditional's value). Each narrowed program runs, reading the Memo's Mood.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { lf, project } from './example';

const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');
const MODULE_KIT = join(REPO, 'packages/module-kit');

/** One space holding a Person `p1` and a Company `c1`, each with one note:
 *  the Person's a Memo (`hi`, Mood `glad`), the Company's a Remark (`yo`,
 *  Tone `dry`). */
const CRM_MODULE = `const { defineModule } = require(${JSON.stringify(join(MODULE_KIT, 'define.ts'))});
const field = (id, name) => ({ fieldId: id, displayName: name, kind: 'string', writable: false, required: false });
const notes = (targetTypeId) => ({ fieldId: 'notes', name: 'Notes', targetTypeId, cardinality: 'many', direction: 'outgoing', readable: true, writable: false });
const subject = (typeId, displayName, noteType) => ({ typeId, displayName, fields: [field('id', 'Id'), field('name', 'Name')], references: [notes(noteType)] });
const types = {
  space: { typeId: 'space', displayName: 'Space', fields: [field('id', 'Id')], references: [
    { fieldId: 'subjects', name: 'Subjects', targetTypeIds: ['person', 'company'], cardinality: 'many', direction: 'outgoing', readable: true, writable: false },
  ] },
  person: subject('person', 'Person', 'memo'),
  company: subject('company', 'Company', 'remark'),
  memo: { typeId: 'memo', displayName: 'Memo', fields: [field('text', 'Text'), field('mood', 'Mood')], references: [] },
  remark: { typeId: 'remark', displayName: 'Remark', fields: [field('text', 'Text'), field('tone', 'Tone')], references: [] },
};
const position = (recordType, id, data) => ({ adapterType: 'crm', recordType, identity: { kind: 'stable', recordId: id, data } });
const held = {
  p1: [position('Memo', 'm1', { Text: 'hi', Mood: 'glad' })],
  c1: [position('Remark', 'r1', { Text: 'yo', Tone: 'dry' })],
};
module.exports = defineModule({
  kind: 'adapter',
  name: 'crm',
  credentials: [],
  protocolMinor: 6,
  manifest: { adapterType: 'crm', displayName: 'Crm', supportedTriggers: [], methods: [] },
  create: () => ({
    adapterType: 'crm',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [
      { typeId: 'space', displayName: 'Space', collectionName: 'Spaces', readable: true, writable: false },
      ...['person', 'company', 'memo', 'remark'].map((typeId) => ({ typeId, displayName: types[typeId].displayName, readable: false, writable: false })),
    ],
    describe: async (typeId) => types[String(typeId).toLowerCase()] ?? null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => position.identity.data?.[fieldId] ?? null,
    getRelated: async ({ position: from, fieldId }) => {
      if (fieldId === 'Spaces') return [{ position: position('Space', 's1', { Id: 's1' }) }];
      if (fieldId === 'subjects' || fieldId === 'Subjects') {
        return [position('Person', 'p1', { Id: 'p1', Name: 'Ada' }), position('Company', 'c1', { Id: 'c1', Name: 'Acme' })].map((p) => ({ position: p }));
      }
      if (fieldId === 'notes' || fieldId === 'Notes') return (held[from.identity.recordId] ?? []).map((p) => ({ position: p }));
      return [];
    },
    createRecord: async () => { throw new Error('read-only'); },
    updateRecord: async () => { throw new Error('read-only'); },
    deleteRecord: async () => { throw new Error('read-only'); },
  }),
});
`;

/** `notes`'s body as `body`, run by hand, after `functions`. */
function crmProject(body: string, functions = ''): string {
  const dir = project();
  rmSync(join(dir, 'movements'), { recursive: true });
  mkdirSync(join(dir, 'movements'));
  mkdirSync(join(dir, 'externals/crm'));
  writeFileSync(join(dir, 'externals/crm/lf-external.yaml'), 'name: crm\nmodule: ./crm.ts\n');
  writeFileSync(join(dir, 'externals/crm/crm.ts'), CRM_MODULE);
  writeFileSync(
    join(dir, 'movements/notes.mvt'),
    `import { crm } from adapters\n\nc = connect crm\n\n${functions}function notes(run: <manual-[:Invocations]->>) {\n${body}\n}\n\nlisten to manual-[:Invocations]-> fire notes\n`,
  );
  return dir;
}

test('a field only one landing of a walk off a union has is refused where it is read', () => {
  const checked = lf(crmProject('  return map(c-[:Spaces]->-[:Subjects]->-[:Notes]->, (n) => { return n.Mood })'), 'check');
  assert.notEqual(checked.code, 0, checked.out);
  assert.match(
    checked.out,
    /MOV_UNION_MEMBER_ONLY 'Mood' can't be read here: since 0\.14, what '-\[:Notes\]->' off c\.Company \| Person lands is c\.Remark or c\.Memo \(0\.13 checked nothing there\).* Narrow it first \(`if \(n is <c-\[:Memo\]->>\) \{ … n\.Mood … \}`\)/,
    checked.out,
  );
  assert.match(checked.out, /1 file\(s\), 1 error\(s\)/, checked.out);
});

test('narrowed to a Person first, the read checks clean and runs, and a field both landings have is read off either', () => {
  const dir = crmProject(`  texts = map(c-[:Spaces]->-[:Subjects]->-[:Notes]->, (n) => { return n.Text })
  moods = c-[:Spaces]->-[s:Subjects]-> {
    if (s is <c-[:Person]->>) {
      return only(s-[:Notes]->).Mood
    }
    return "-"
  }
  return { texts: texts, moods: moods }`);
  const checked = lf(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /1 file\(s\), 0 error\(s\)/, checked.out);

  const ran = lf(dir, 'run', 'notes');
  assert.equal(ran.code, 0, ran.out);
  const runId = /^run (\S+) /m.exec(ran.out)?.[1] ?? '';
  assert.notEqual(runId, '', ran.out);
  const shown = lf(dir, 'runs', 'show', runId, '--json');
  assert.equal(shown.code, 0, shown.out);
  const { run } = JSON.parse(shown.out) as { run: { status: string; returned: { value: unknown } } };
  assert.equal(run.status, 'completed', shown.out);
  assert.deepEqual(run.returned.value, { texts: ['hi', 'yo'], moods: ['glad', '-'] }, shown.out);
});

/** The run of `dir`'s `notes`, completed: what it returned. */
function returned(dir: string): unknown {
  const ran = lf(dir, 'run', 'notes');
  assert.equal(ran.code, 0, ran.out);
  const runId = /^run (\S+) /m.exec(ran.out)?.[1] ?? '';
  assert.notEqual(runId, '', ran.out);
  const shown = lf(dir, 'runs', 'show', runId, '--json');
  assert.equal(shown.code, 0, shown.out);
  const { run } = JSON.parse(shown.out) as { run: { status: string; returned: { value: unknown } } };
  assert.equal(run.status, 'completed', shown.out);
  return run.returned.value;
}

test('a note narrowed with is reads its own fields: a landing, a union parameter, a conditional value', () => {
  const functions = `function mood(n: <c-[:Memo]-> | c-[:Remark]->>) {
  if (n is <c-[:Memo]->>) {
    return n.Mood
  } else {
    return n.Tone
  }
}

`;
  const dir = crmProject(
    `  inBlock = c-[:Spaces]->-[:Subjects]->-[n:Notes]-> {
    if (n is <c-[:Memo]->>) {
      return n.Mood
    } else {
      return n.Tone
    }
  }
  viaParam = map(c-[:Spaces]->-[:Subjects]->-[:Notes]->, (n) => { return mood(n) })
  ofPerson = only(c-[:Spaces]->-[s:Subjects WHERE s.Id == "p1"]->-[:Notes]->)
  ofCompany = only(c-[:Spaces]->-[s:Subjects WHERE s.Id == "c1"]->-[:Notes]->)
  picked = count(inBlock) > 5 ? ofPerson : ofCompany
  if (picked is <c-[:Memo]->>) {
    return { inBlock: inBlock, viaParam: viaParam, picked: picked.Mood }
  } else {
    return { inBlock: inBlock, viaParam: viaParam, picked: picked.Tone }
  }`,
    functions,
  );
  const checked = lf(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /1 file\(s\), 0 error\(s\)/, checked.out);
  assert.deepEqual(returned(dir), { inBlock: ['glad', 'dry'], viaParam: ['glad', 'dry'], picked: 'dry' });

  const misread = lf(crmProject('  return c-[:Spaces]->-[:Subjects]->-[n:Notes]-> {\n    if (n is <c-[:Memo]->>) {\n      return n.Tone\n    }\n    return n.Mood\n  }'), 'check');
  assert.equal(misread.code, 1, misread.out);
  assert.match(misread.out, /error MOV_UNKNOWN_PROPERTY .*'Tone'/, misread.out);
  assert.match(misread.out, /error MOV_UNION_MEMBER_ONLY 'Mood' can't be read here/, misread.out);
});
