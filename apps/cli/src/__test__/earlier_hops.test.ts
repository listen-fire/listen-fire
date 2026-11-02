// A later hop's WHERE and ORDER BY read an earlier hop's alias in a run:
// `s-[t:Tables]->-[c:History WHERE c.Id == t.Name]->` filters each Table's
// History by that Table's own Name. Two Tables, `A` and `B`, each with the
// changes `A`, `B` and `C` (each change's `Kind` naming its Table and its
// id), so a walk that named one Table for every path would land on `A:A`
// and `B:A`, not `A:A` and `B:B`. Read in a block head, a walk inside an
// expression, `exists` and an ORDER BY, through the real binary.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { lf, project } from './example';

const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');
const MODULE_KIT = join(REPO, 'packages/module-kit');

/** Tables `A` and `B`; off a Table, its History. Each History fetch's pushed
 *  `where` is logged to `asked.log`, with the Table it was asked off. */
const STORE_MODULE = `const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const { defineModule } = require(${JSON.stringify(join(MODULE_KIT, 'define.ts'))});
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
    getRelated: async ({ position: from, fieldId, where }) => {
      if (fieldId === 'Tables') return ['A', 'B'].map((name) => ({ position: position('Table', name, { Name: name }) }));
      if (fieldId === 'history' || fieldId === 'History') {
        const table = from.identity.recordId;
        appendFileSync(join(__dirname, 'asked.log'), JSON.stringify({ table, where }) + '\\n');
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

const MOVEMENT = `import { store } from adapters

s = connect store

function hops(run: <manual-[:Invocations]->>) {
  blocks = s-[t:Tables]->-[c:History WHERE c.Id == t.Name]-> {
    return c.Kind
  }
  walked = map(s-[t:Tables]->-[c:History WHERE c.Id == t.Name]->, (r) => { return r.Kind })
  found = exists(s-[t:Tables]->-[c:History WHERE c.Id == t.Name AND c.Kind == "B:B"]->)
  crossed = exists(s-[t:Tables]->-[c:History WHERE c.Id == t.Name AND c.Kind == "B:A"]->)
  ordered = map(s-[t:Tables]->-[c:History ORDER BY (c.Id == t.Name ? "0" : "1") LIMIT 1]->, (r) => { return r.Kind })
  return { blocks: blocks, walked: walked, found: found, crossed: crossed, ordered: ordered }
}

listen to manual-[:Invocations]-> fire hops
`;

function storeProject(): string {
  const dir = project();
  rmSync(join(dir, 'movements'), { recursive: true });
  mkdirSync(join(dir, 'movements'));
  mkdirSync(join(dir, 'externals/store'));
  writeFileSync(join(dir, 'externals/store/lf-external.yaml'), 'name: store\nmodule: ./store.ts\n');
  writeFileSync(join(dir, 'externals/store/store.ts'), STORE_MODULE);
  writeFileSync(join(dir, 'movements/hops.mvt'), MOVEMENT);
  return dir;
}

test("a later hop reads each path's own earlier hop: checked clean, run, and shown", () => {
  const dir = storeProject();
  const checked = lf(dir, 'check');
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /1 file\(s\), 0 error\(s\)/);

  const ran = lf(dir, 'run', 'hops');
  assert.equal(ran.code, 0, ran.out);
  const runId = /^run (\S+) /m.exec(ran.out)?.[1] ?? '';
  assert.notEqual(runId, '', ran.out);

  const shown = lf(dir, 'runs', 'show', runId, '--json');
  assert.equal(shown.code, 0, shown.out);
  const { run } = JSON.parse(shown.out) as { run: { status: string; returned: { value: unknown } } };
  assert.equal(run.status, 'completed', shown.out);
  assert.deepEqual(run.returned.value, { blocks: ['A:A', 'B:B'], walked: ['A:A', 'B:B'], found: true, crossed: false, ordered: ['A:A', 'B:B'] }, shown.out);

  // Each Table's History fetch was asked that Table's own Name.
  const asked = readFileSync(join(dir, 'externals/store/asked.log'), 'utf8').split('\n').filter((line) => line !== '');
  const pushed = asked.map((line) => JSON.parse(line) as { table: string; where?: { right?: { value?: string }; operands?: Array<{ right?: { value?: string } }> } });
  const named = pushed.filter((ask) => ask.where !== undefined).map((ask) => [ask.table, ask.where?.right?.value ?? ask.where?.operands?.[0]?.right?.value]);
  assert.ok(named.length >= 2, asked.join('\n'));
  for (const [table, value] of named) assert.equal(value, table, asked.join('\n'));
});
