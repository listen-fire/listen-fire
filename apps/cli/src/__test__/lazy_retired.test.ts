// `lazy` is retired in 0.14 for a closure: `tables = () => s-[t:Tables]->`,
// read as `tables()`. A project written with `lazy` is refused by
// `listen-fire check` and by `listen-fire upgrade`, even with `--all`
// (MOV_LAZY_RETIRED, naming the closure to write), and nothing is rewritten:
// the author replaces each `lazy` by hand. The closures they write check
// clean, and the run returns what the `lazy` project's run returned under 0.13.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { lf, project } from './example';

const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');
const MODULE_KIT = join(REPO, 'packages/module-kit');

/** Tables `A` and `B`; off each, its History `A`, `B` and `C`. */
const STORE_MODULE = `const { defineModule } = require(${JSON.stringify(join(MODULE_KIT, 'define.ts'))});
const field = (id, name) => ({ fieldId: id, displayName: name, kind: 'string', writable: false, required: false });
const types = {
  table: { typeId: 'table', displayName: 'Table', fields: [field('name', 'Name')], references: [
    { fieldId: 'history', name: 'History', targetTypeId: 'change', cardinality: 'many', direction: 'outgoing', readable: true, writable: false },
  ] },
  change: { typeId: 'change', displayName: 'Change', fields: [field('id', 'Id'), field('kind', 'Kind')], references: [] },
};
const position = (recordType, id, data) => ({ adapterType: 'store', recordType, identity: { kind: 'stable', recordId: id, data } });
module.exports = defineModule({
  kind: 'adapter',
  name: 'store',
  credentials: [],
  protocolMinor: 6,
  manifest: { adapterType: 'store', displayName: 'Store', supportedTriggers: [], methods: [] },
  create: () => ({
    adapterType: 'store',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [
      { typeId: 'table', displayName: 'Table', collectionName: 'Tables', readable: true, writable: false },
      { typeId: 'change', displayName: 'Change', readable: false, writable: false },
    ],
    describe: async (typeId) => types[String(typeId).toLowerCase()] ?? null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => position.identity.data?.[fieldId] ?? null,
    getRelated: async ({ position: from, fieldId }) => {
      if (fieldId === 'Tables') return ['A', 'B'].map((name) => ({ position: position('Table', name, { Name: name }) }));
      if (fieldId === 'history' || fieldId === 'History') {
        const table = from.identity.recordId;
        return ['A', 'B', 'C'].map((id) => ({ position: position('Change', table + '-' + id, { Id: id, Kind: table + ':' + id }) }));
      }
      return [];
    },
    createRecord: async () => { throw new Error('read-only'); },
    updateRecord: async () => { throw new Error('read-only'); },
    deleteRecord: async () => { throw new Error('read-only'); },
  }),
});
`;

const LAZY = `import { store } from adapters

s = connect store

function kept() {
  return lazy s-[t:Tables]->
}

function lz(run: <manual-[:Invocations]->>) {
  tables = lazy s-[t:Tables]->
  n = count(tables)
  names = tables.Name
  past = tables-[c:History WHERE c.Id == "A"]-> {
    return c.Kind
  }
  pastCount = count(tables-[:History]->)
  labelled = lazy s-[t:Tables]-> node { label: t.Name }
  labels = labelled.label
  shown = "\${tables.Name}"
  returned = kept().Name
  g = node { tabs: lazy s-[t:Tables]->, label: "x" }
  viaNode = g-[x:tabs]-> {
    return x.Name
  }
  return { n: n, names: names, past: past, pastCount: pastCount, labels: labels, shown: shown, returned: returned, viaNode: viaNode }
}

listen to manual-[:Invocations]-> fire lz
`;

/** LAZY with each `lazy` replaced by hand. */
const CLOSURES = LAZY.replace('return lazy s-', 'return s-')
  .replace('tables = lazy s-', 'tables = () => s-')
  .replace('count(tables)', 'count(tables())')
  .replace('names = tables.Name', 'names = tables().Name')
  .replace('past = tables-', 'past = tables()-')
  .replace('count(tables-', 'count(tables()-')
  .replace('labelled = lazy s-[t:Tables]-> node { label: t.Name }', 'labelled = () => {\n    return s-[t:Tables]-> {\n      return node { label: t.Name }\n    }\n  }')
  .replace('labelled.label', 'labelled().label')
  .replace('${tables.Name}', '${tables().Name}')
  .replace('tabs: lazy s-', 'tabs: s-');

/** What the run of LAZY returned under 0.13 (listen-fire at c9fe6ec6f0). */
const RETURNED_UNDER_0_13 = {
  n: 2,
  names: ['A', 'B'],
  past: ['A:A', 'B:A'],
  pastCount: 6,
  labels: ['A', 'B'],
  shown: 'A,B',
  returned: ['A', 'B'],
  viaNode: ['A', 'B'],
};

function storeProject(): string {
  const dir = project();
  rmSync(join(dir, 'movements'), { recursive: true });
  mkdirSync(join(dir, 'movements'));
  mkdirSync(join(dir, 'externals/store'));
  writeFileSync(join(dir, 'externals/store/lf-external.yaml'), 'name: store\nmodule: ./store.ts\n');
  writeFileSync(join(dir, 'externals/store/store.ts'), STORE_MODULE);
  writeFileSync(join(dir, 'movements/lz.mvt'), LAZY);
  return dir;
}

test('lazy is refused by check and upgrade, by name, and the closures written by hand run as it did', () => {
  const dir = storeProject();
  const refused = lf(dir, 'check');
  assert.equal(refused.code, 1, refused.out);
  assert.equal((refused.out.match(/ error MOV_LAZY_RETIRED /g) ?? []).length, 4, refused.out);
  assert.match(refused.out, /replace it by hand with a closure, `tables = \(\) => s-\[t:Tables\]->`, read as `tables\(\)`/);

  for (const args of [['upgrade'], ['upgrade', '--all']]) {
    const upgraded = lf(dir, ...args);
    assert.equal(upgraded.code, 1, upgraded.out);
    assert.equal((upgraded.out.match(/ error MOV_LAZY_RETIRED .*\(`listen-fire upgrade` does not rewrite it\)/g) ?? []).length, 4, upgraded.out);
    assert.doesNotMatch(upgraded.out, /fix \(not applied/, upgraded.out);
    assert.match(upgraded.out, /1 file\(s\), 0 rewritten, 4 left to change by hand/, upgraded.out);
    assert.equal(readFileSync(join(dir, 'movements/lz.mvt'), 'utf8'), LAZY);
  }

  writeFileSync(join(dir, 'movements/lz.mvt'), CLOSURES);
  const checked = lf(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /1 file\(s\), 0 error\(s\)/);

  const ran = lf(dir, 'run', 'lz');
  assert.equal(ran.code, 0, ran.out);
  const runId = /^run (\S+) /m.exec(ran.out)?.[1] ?? '';
  assert.notEqual(runId, '', ran.out);
  const shown = lf(dir, 'runs', 'show', runId, '--json');
  assert.equal(shown.code, 0, shown.out);
  const { run } = JSON.parse(shown.out) as { run: { status: string; returned: { value: unknown } } };
  assert.equal(run.status, 'completed', shown.out);
  assert.deepEqual(run.returned.value, RETURNED_UNDER_0_13, shown.out);
});
