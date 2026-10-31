// `listen-fire catalog` and `listen-fire check` on the example, clean and refused; and the
// schema projection (checked against the TypeScript reference in
// movement-engine) over introspection shapes the example never sends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { schemaEntryPointSchema, schemaTypeDescriptorSchema } from 'engine-contracts/catalog';
import { project } from './example';
import { lfBinary } from './lf_bin';

function edit(dir: string, change: (source: string) => string): void {
  const path = join(dir, 'movements/companies.mvt');
  const source = readFileSync(path, 'utf8');
  const changed = change(source);
  assert.notEqual(changed, source, 'the edit must change the example');
  writeFileSync(path, changed);
}

test('listen-fire catalog: the snapshot of the example\'s external, as one JSON document', () => {
  const dir = project();
  const run = spawnSync(lfBinary(), ['catalog'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const catalog: unknown = JSON.parse(run.stdout);
  assert.ok(typeof catalog === 'object' && catalog !== null && JSON.stringify(catalog).includes('Company'), run.stdout.slice(0, 300));
});

const CHECKED: Array<{ name: string; change?: (source: string) => string; noSecrets?: true; refused?: RegExp }> = [
  { name: 'the example, clean' },
  { name: 'a name nothing binds and a field the type lacks', change: (s) => s.replace('Name: "Welcome ${company.Name}"', 'Nme: "Welcome ${nobody}"'), refused: /Nme|nobody/ },
  { name: 'a listen config key the external does not declare', change: (s) => s.replace('{ events: ["company.created"] }', '{ colour: "red" }'), refused: /colour/ },
  { name: 'an event the external does not declare', change: (s) => s.replace('"company.created"', '"company.deleted"'), refused: /company\.deleted/ },
  { name: 'a file that does not parse', change: (s) => s.replace('fire welcome', 'fire welcome {'), refused: /./ },
  { name: 'a credential the secrets lack', noSecrets: true, refused: /acme/ },
];

for (const c of CHECKED) {
  test(`listen-fire check: ${c.name}`, () => {
    const dir = project();
    if (c.change !== undefined) edit(dir, c.change);
    if (c.noSecrets === true) rmSync(join(dir, '.lf/secrets.yaml'));
    const run = spawnSync(lfBinary(), ['check'], { cwd: dir, encoding: 'utf8' });
    if (c.refused === undefined) return assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(run.stdout + run.stderr, c.refused);
  });
}

test('listen-fire check: a module that declares a retired reference key', () => {
  const dir = project();
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const source = readFileSync(server, 'utf8');
  const stale = source.replace('listenable: true,', 'awaitable: true,');
  assert.notEqual(stale, source, 'the edit must change the external');
  writeFileSync(server, stale);
  const run = spawnSync(lfBinary(), ['check'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(
    run.stdout + run.stderr,
    /'Comments' declares 'awaitable', retired in 0\.13: declare 'listenable: true' \(and, optionally, 'identity': the landing's field that names an arrival\)/,
  );
});

test('listen-fire check: a module that declares resolvesEmpty', () => {
  const dir = project();
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const source = readFileSync(server, 'utf8');
  const stale = source.replace('listenable: true,', 'listenable: true, resolvesEmpty: true,');
  assert.notEqual(stale, source, 'the edit must change the external');
  writeFileSync(server, stale);
  const run = spawnSync(lfBinary(), ['check'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(
    run.stdout + run.stderr,
    /'Comments' declares 'resolvesEmpty', retired in 0\.13: a deleted record leaves the wait waiting on every edge, so there is nothing to declare: drop it/,
  );
});

test('listen-fire check: a module whose identity names a field the landing does not declare', () => {
  const dir = project();
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const source = readFileSync(server, 'utf8');
  const stale = source.replace("identity: 'Id',", "identity: 'id',");
  assert.notEqual(stale, source, 'the edit must change the external');
  writeFileSync(server, stale);
  const run = spawnSync(lfBinary(), ['check'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout + run.stderr, /'Comments' names 'id' as its identity, a field its landing 'Comment' does not declare \(it declares: Id, Text\)/);
});

/** The example's external, its source changed by each `[from, to]`. */
function external(dir: string, ...changes: Array<[string, string]>): void {
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const source = readFileSync(server, 'utf8');
  const changed = changes.reduce((text, [from, to]) => text.replace(from, to), source);
  for (const [from] of changes) assert.ok(source.includes(from), `the external has no ${from}`);
  writeFileSync(server, changed);
}

test('listen-fire check and catalog: what a module declares about listening reaches the catalog', () => {
  const dir = project();
  external(
    dir,
    ["identity: 'Id',", "identity: 'Id', delivery: 'connection', carries: ['Company'], attributes: true,"],
    ['fires: true,', "fires: true, listenable: true, identity: 'Name', delivery: 'polled', pollEverySeconds: 60,"],
    [
      "{ fieldId: 'Report', displayName: 'Report', kind: 'file', writable: true, required: false },",
      "{ fieldId: 'Report', displayName: 'Report', kind: 'file', writable: true, required: false }, { fieldId: 'Schedule', displayName: 'Schedule', kind: 'owned', owned: { name: 'Cron' }, writable: false, required: false },",
    ],
    ["adapterType: 'acme_crm',", "adapterType: 'acme_crm', resendWindowSeconds: 259200,"],
  );
  const check = spawnSync(lfBinary(), ['check'], { cwd: dir, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const run = spawnSync(lfBinary(), ['catalog'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const Catalog = z.object({
    adapters: z.record(
      z.string(),
      z.object({ resendWindowSeconds: z.number().optional(), schemas: z.record(z.string(), z.object({ collections: z.record(z.string(), z.unknown()), positions: z.record(z.string(), z.unknown()) })) }),
    ),
  });
  const acme = Catalog.parse(JSON.parse(run.stdout)).adapters.acme_crm;
  assert.ok(acme !== undefined);
  assert.equal(acme.resendWindowSeconds, 259200);
  const schema = Object.values(acme.schemas)[0];
  assert.ok(schema !== undefined);
  assert.deepEqual(schema.collections.Company, { target: 'Company', readable: false, listenable: true, identity: 'Name', delivery: 'polled', pollEverySeconds: 60 });
  const company = JSON.stringify(schema.positions.Company);
  assert.ok(company.includes('"delivery":"connection","carries":["Company"],"attributes":true'), company);
  assert.ok(company.includes('"Schedule":{"kind":"owned","name":"Cron","owner":"acme_crm"}'), company);
});

const LISTENING_REFUSED: Array<{ name: string; change: [string, string]; refused: RegExp }> = [
  {
    name: 'a polled edge that does not state its interval',
    change: ["identity: 'Id',", "identity: 'Id', delivery: 'polled',"],
    refused: /describes 'Company': 'Comments' declares 'delivery: polled' but no 'pollEverySeconds': state how often the module polls it/,
  },
  {
    name: 'an unbounded edge with nothing to narrow it by',
    change: ["identity: 'Id',", "identity: 'Id', bounded: false,"],
    refused: /'Comments' declares 'bounded: false' but no 'boundedBy': name the fields a listen narrows it by/,
  },
  {
    name: 'a boundedBy that names no field of the landing',
    change: ["identity: 'Id',", "identity: 'Id', bounded: false, boundedBy: ['Author'],"],
    refused: /'Comments' names 'Author' in its boundedBy, a field its landing 'Comment' does not declare \(it declares: Id, Text\)/,
  },
  {
    name: 'carries naming no earlier hop',
    change: ["identity: 'Id',", "identity: 'Id', carries: ['Nope'],"],
    refused: /'Comments' says its arrivals carry earlier hops, but 'carries' names 'Nope', which is no edge into 'Company' \(the edges into it: Company\)/,
  },
  {
    name: 'a root collection cheap to list that says nothing of how its members change',
    change: ['fires: true,', 'fires: true, cheapToList: true,'],
    refused: /lists 'Company': 'Company' declares 'cheapToList: true' but neither 'parentChanges: pushed' nor 'relistEvery': say how a listen learns its members changed/,
  },
  {
    name: 'a resend window that is not a number of seconds',
    change: ["adapterType: 'acme_crm',", "adapterType: 'acme_crm', resendWindowSeconds: 0,"],
    refused: /resendWindowSeconds: expected a positive whole number/,
  },
];

for (const c of LISTENING_REFUSED) {
  test(`listen-fire check: a module that declares ${c.name}`, () => {
    const dir = project();
    external(dir, c.change);
    const run = spawnSync(lfBinary(), ['check'], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, c.refused);
  });
}

// ── The schema projection over shapes the example's external never sends ──

const Introspection = z.object({
  adapterType: z.string(),
  entries: z.array(schemaEntryPointSchema),
  reached: z.array(schemaEntryPointSchema).optional(),
  allEntries: z.array(schemaEntryPointSchema).optional(),
  descriptors: z.array(z.tuple([z.string(), schemaTypeDescriptorSchema])),
  metaDescriptor: schemaTypeDescriptorSchema.optional(),
  supportsInPlaceUpdate: z.boolean(),
  edgesCarryProperties: z.boolean().optional(),
  lazilyWalked: z.boolean().optional(),
});

const field = (fieldId: string, kind: string, extra: Record<string, unknown> = {}) => ({ fieldId, displayName: fieldId, kind, writable: false, required: false, ...extra });
const entry = (typeId: string, displayName: string, extra: Record<string, unknown> = {}) => ({ typeId, displayName, readable: true, writable: true, scope: 'self-configured', ...extra });

const INTROSPECTIONS: Record<string, unknown> = {
  'a wide adapter: kinds, clashes, unions, write unions, discriminated writes': {
    adapterType: 'wide',
    supportsInPlaceUpdate: true,
    entries: [
      entry('co', 'Company', { fires: true, firesOn: ['create'] }),
      entry('pp', 'Person', { collectionName: 'People' }),
      entry('nt', 'Note', { readable: false, writable: false }),
      entry('dl', 'Deal'),
      entry('dla', 'Deal A', { readable: false, writable: false }),
      entry('co2', 'Company', { writable: false }),
      entry('ud', 'Ghost', { writable: false }),
      entry('w', 'Weird', { collectionName: '@weird' }),
    ],
    descriptors: [
      [
        'co',
        {
          typeId: 'co',
          displayName: 'Company',
          deletable: true,
          fields: [
            field('name', 'string', { displayName: 'Name', writable: true, required: true, description: 'The legal name' }),
            field('tags', 'string', { displayName: 'Tags', cardinality: 'many', knownValues: ['vip', 'lead'], knownValuePattern: '^t_' }),
            field('stage', 'enum', { displayName: 'Stage', enumValues: ['new', 'won'], writable: true }),
            field('loose', 'enum', { displayName: 'Loose' }),
            field('meta', 'json', { displayName: 'Meta' }),
            field('score', 'number', { displayName: 'Score', capability: { filterOperators: ['eq', 'gt'], orderable: true } }),
            field('secret', 'string', { displayName: 'Secret', writable: true, readable: false }),
            field('name2', 'string', { displayName: 'Name' }),
            field('where', 'date', { displayName: '2' }),
            field('people_ref', 'reference', { displayName: 'People Ref' }),
          ],
          references: [
            { fieldId: 'people', name: 'People', targetTypeId: 'pp', cardinality: 'many', direction: 'outgoing', writable: true, required: true, listenable: true, cursor: false, identity: 'Email', version: 'Email' },
            { fieldId: 'notes', name: 'Notes', targetTypeId: 'nt', cardinality: 'many', direction: 'outgoing', readable: false, linkable: false, sequenced: 'chronological' },
            { fieldId: 'related', name: 'Related', targetTypeId: 'pp', targetTypeIds: ['pp', 'dl', 'pp'], cardinality: 'many', direction: 'outgoing', writable: true },
            { fieldId: 'orphan', name: 'Orphan', targetTypeId: 'missing', cardinality: 'one', direction: 'outgoing' },
            { fieldId: '_resources', name: 'Resources', targetTypeId: 'res', cardinality: 'many', direction: 'outgoing' },
            { fieldId: 'old', name: '@old', targetTypeId: 'pp', cardinality: 'one', direction: 'outgoing' },
          ],
          uniquenessConstraints: { any: [{ all: [{ field: 'name' }] }, { all: [{ field: 'people' }] }, { all: [{ field: 'nope' }] }, { all: [] }] },
          supportsFuzzyResolution: ['name', 'secret', 'missing'],
          writeUnion: { variants: [{ name: 'byName', fields: ['name', 'secret'] }, { name: 'byStage', fields: ['stage', 'name'] }] },
        },
      ],
      ['pp', { typeId: 'pp', displayName: 'Person', fields: [field('email', 'string', { displayName: 'Email', writable: true, pinned: true })], references: [] }],
      ['nt', { typeId: 'nt', displayName: 'Note', fields: [field('text', 'string', { displayName: 'Text' })], references: [] }],
      [
        'dl',
        {
          typeId: 'dl',
          displayName: 'Deal',
          uniquenessAuthorable: false,
          fields: [
            field('kind', 'enum', { displayName: 'Kind', enumValues: ['A', 'B'], writable: true, required: true }),
            field('amount', 'number', { displayName: 'Amount', writable: true, description: '' }),
          ],
          references: [{ fieldId: 'variant', name: 'Variant', targetTypeId: 'dla', cardinality: 'one', direction: 'outgoing', writable: true }],
          discriminatedWrite: { discriminant: 'Kind', variantTypes: { A: 'Deal A', B: 'Never Described' } },
        },
      ],
      ['dla', { typeId: 'dla', displayName: 'Deal A', fields: [field('extra', 'string', { displayName: 'Extra', writable: true, required: true })], references: [] }],
      ['co2', { typeId: 'co2', displayName: 'Company', fields: [], references: [] }],
      ['w', { typeId: 'w', displayName: 'Weird', fields: [field('x', 'boolean', { displayName: 'X', writable: true })], references: [] }],
    ],
  },
  'a walked instance: a root descriptor, reached types, a scoped describe': {
    adapterType: 'walked',
    supportsInPlaceUpdate: false,
    edgesCarryProperties: true,
    lazilyWalked: true,
    entries: [entry('base', 'Base', { writable: false })],
    allEntries: [entry('base', 'Base', { writable: false }), entry('other', 'Other', { writable: false })],
    reached: [entry('tbl', 'Table', { readable: false })],
    metaDescriptor: {
      typeId: '__meta',
      displayName: 'Root',
      fields: [],
      references: [
        { fieldId: 'base', name: 'Base', targetTypeId: 'base', cardinality: 'many', direction: 'outgoing', capability: { filter: 'native', supportsLimit: true } },
        { fieldId: 'gone', name: 'Gone', targetTypeId: 'base', cardinality: 'many', direction: 'outgoing', capability: { order: 'bounded', supportsLimit: false, naturalOrder: { field: 'Cell', direction: 'desc' } } },
      ],
    },
    descriptors: [
      ['base', { typeId: 'base', displayName: 'Base', fields: [], references: [{ fieldId: 'tables', name: 'Tables', targetTypeId: 'tbl', cardinality: 'many', direction: 'outgoing' }, { fieldId: 'later', name: 'Later', targetTypeId: 'unwalked', cardinality: 'many', direction: 'outgoing' }] }],
      ['tbl', { typeId: 'tbl', displayName: 'Table', fields: [field('cell', 'string', { displayName: 'Cell', writable: true })], references: [] }],
    ],
  },
  'a listening adapter: a listenable root, what edges say of their arrivals, owned scalars': {
    adapterType: 'listening',
    supportsInPlaceUpdate: false,
    entries: [
      entry('tick', 'Tick', {
        collectionName: 'Ticks',
        readable: false,
        writable: false,
        listenable: true,
        identity: 'Fired At',
        bounded: false,
        boundedBy: ['Schedule'],
        delivery: 'polled',
        pollEverySeconds: 60,
      }),
      entry('base', 'Base', { collectionName: 'Bases', writable: false, cheapToList: true, parentChanges: 'pushed' }),
      entry('tbl', 'Table', { readable: false, writable: false }),
      entry('chg', 'Change', { readable: false, writable: false }),
      entry('log', 'Log', { readable: false }),
    ],
    descriptors: [
      [
        'tick',
        {
          typeId: 'tick',
          displayName: 'Tick',
          fields: [
            field('fired', 'date', { displayName: 'Fired At' }),
            field('schedule', 'owned', { displayName: 'Schedule', owned: { name: 'Cron' } }),
            field('keys', 'owned', { displayName: 'Keys', cardinality: 'many', owned: { name: 'Key', allowPattern: '^[a-z]+$' } }),
          ],
          references: [],
        },
      ],
      ['base', { typeId: 'base', displayName: 'Base', fields: [], references: [{ fieldId: 'tables', name: 'Tables', targetTypeId: 'tbl', cardinality: 'many', direction: 'outgoing', cheapToList: true, relistEvery: 300 }] }],
      [
        'tbl',
        {
          typeId: 'tbl',
          displayName: 'Table',
          fields: [],
          references: [
            { fieldId: 'changes', name: 'Changes', targetTypeId: 'chg', cardinality: 'many', direction: 'outgoing', readable: false, listenable: true, identity: 'Id', cursor: true, delivery: 'scope', carries: ['Bases', 'Tables'], attributes: true },
          ],
        },
      ],
      ['chg', { typeId: 'chg', displayName: 'Change', fields: [field('id', 'string', { displayName: 'Id' })], references: [] }],
      ['log', { typeId: 'log', displayName: 'Log', fields: [field('line', 'string', { displayName: 'Line', writable: true })], references: [] }],
    ],
  },
  'one readable entry and no event edge: the event position by the heuristic': {
    adapterType: 'single',
    supportsInPlaceUpdate: true,
    entries: [entry('only', 'Only', { writable: false }), entry('child', 'Child', { readable: false, writable: false })],
    descriptors: [['only', { typeId: 'only', displayName: 'Only', fields: [field('a', 'string', { cardinality: 'many' })], references: [] }]],
  },
};

/** What each introspection must make the projection say, so a parity over
 *  an output that exercises nothing cannot pass for one. */
const EXERCISES: Record<string, { members: string[]; notes: number }> = {
  'a wide adapter: kinds, clashes, unions, write unions, discriminated writes': {
    members: ['listenable', 'cursor', 'identity', 'version', 'unions', 'unionDisplayNames', 'createShapes', 'discriminated', 'writeOnlyProperties', 'ambiguousProperties', 'pinnedProperties', 'propertyCapabilities', 'nativeUniqueness', 'fuzzyResolution', 'writeUnion', 'requiredEdges', 'fieldDocs', 'resources', 'polymorphic', 'eventPositions'],
    notes: 6,
  },
  'a walked instance: a root descriptor, reached types, a scoped describe': { members: ['capability', 'edgesCarryProperties', 'undescribed'], notes: 1 },
  'a listening adapter: a listenable root, what edges say of their arrivals, owned scalars': {
    members: ['readable', 'listenable', 'identity', 'cursor', 'bounded', 'boundedBy', 'delivery', 'pollEverySeconds', 'carries', 'attributes', 'cheapToList', 'parentChanges', 'relistEvery', 'owner', 'allowPattern'],
    notes: 0,
  },
  'one readable entry and no event edge: the event position by the heuristic': { members: ['eventPosition'], notes: 0 },
};

for (const [name, raw] of Object.entries(INTROSPECTIONS)) {
  test(`listen-fire projects a schema as the reference projection does: ${name}`, () => {
    const input = Introspection.parse(raw);
    const expected = instanceSchemaFromDescriptors({ ...input, descriptors: new Map(input.descriptors) });
    const exercised = EXERCISES[name];
    assert.ok(exercised !== undefined);
    const text = JSON.stringify(expected.schema);
    for (const member of exercised.members) assert.ok(text.includes(`"${member}":`), `the projection says nothing of ${member}`);
    assert.ok(expected.notes.length >= exercised.notes, expected.notes.join('\n'));
    const rust = spawnSync(lfBinary(), ['--project-schema'], { input: JSON.stringify(input), encoding: 'utf8' });
    assert.equal(rust.status, 0, rust.stderr);
    assert.equal(rust.stdout.trim(), JSON.stringify({ schema: expected.schema, notes: expected.notes }));
  });
}
