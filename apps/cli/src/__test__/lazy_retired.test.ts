// `lazy` is retired in 0.14 for a closure: `tables = () => s-[t:Tables]->`,
// read as `tables()`. A project written with `lazy` is refused by
// `listen-fire check` (MOV_LAZY_RETIRED); `listen-fire upgrade --all` rewrites
// each `lazy` (a binding to a closure and its reads to calls, a returned walk
// without it, a node's entry without it), the rewritten project checks clean,
// and its run returns what the `lazy` project's run returned under 0.13.

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

test('lazy is refused, upgraded to closures that check clean, and the run returns what it did', () => {
  const dir = storeProject();
  const refused = lf(dir, 'check');
  assert.equal(refused.code, 1, refused.out);
  assert.equal((refused.out.match(/ error MOV_LAZY_RETIRED /g) ?? []).length, 4, refused.out);
  assert.match(refused.out, /Write `tables = \(\) => s-\[t:Tables\]->` and read it as `tables\(\)`; `listen-fire upgrade` rewrites it/);

  // Without --all, the node's entry is listed and holds the pin.
  const safe = lf(dir, 'upgrade', '--check');
  assert.equal(safe.code, 1, safe.out);
  assert.match(safe.out, /MOV_LAZY_RETIRED .*no node entry walks again at each read/);
  assert.match(safe.out, /fix \(not applied, may change meaning; --all applies it\): "tabs: "/);

  const upgraded = lf(dir, 'upgrade', '--all');
  assert.equal(upgraded.code, 0, upgraded.out);
  const rewritten = readFileSync(join(dir, 'movements/lz.mvt'), 'utf8');
  assert.doesNotMatch(rewritten, /\blazy\b/, rewritten);
  assert.match(rewritten, /tables = \(\) => s-\[t:Tables\]->\n  n = count\(tables\(\)\)\n  names = tables\(\)\.Name\n/, rewritten);
  assert.match(rewritten, / {2}return s-\[t:Tables\]->\n/, rewritten);
  assert.match(rewritten, /g = node \{ tabs: s-\[t:Tables\]->, label: "x" \}/, rewritten);

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
