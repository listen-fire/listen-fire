// Unit tests for the Airtable TG adapter — pure helpers + mocked-client paths
// only (no network, no LLM). Covers:
//   1. the name → structured-identifier cache: a recordType NAMED by its
//      displayName resolves to its `{ baseId, tableId }` and routes correctly.
//   2. coerceAirtableValue per Airtable field type.
//   3. describe — field/reference/writable mapping against a mocked listTables.
//   4. resolveEntity — filterByFormula building from constraints (exact branch)
//      against a mocked listRecords, with allEntriesExact attribution.
//   5. a write that filters read-only fields + coerces values.
//
// The API client is mocked by overriding the adapter's private getApiClient;
// fake-channels is never hit. Module-scope deps that crash at load (credentials
// master key, logger → casl, the broken zod chain) are stubbed exactly as the
// Attio adapter test does.

jest.mock('movement-engine/public/log', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));


import type { ResolveEntityInput } from 'movement-engine/public/adapter';

import { AirtableAdapter } from '../index';
import {
  DEALS_TYPE,
  LINKED_TABLE_ID,
  PEOPLE_TYPE,
  BASE_ID,
  TABLE_ID,
  dealsTable,
  makeAdapter,
  makeMultiBaseAdapter,
  peopleTable,
  tasksTable,
  testFileStore,
  type FakeRecord,
} from '../testing';
import { coerceAirtableValue } from '../record';
import { makeStablePosition, makeMetaPosition, makeUnstablePosition, positionData } from 'movement-engine/public/catalog';
import { arrivalsFromPayload, changeDataOf, changesTables } from '../webhook';
import { instanceSchemaFromDescriptors } from 'movement-engine/public/catalog';


// ---------------------------------------------------------------------------
// Fake API client + table fixtures
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 1. Name → structured-identifier cache
// ---------------------------------------------------------------------------
// The recordType carried on positions is the pretty NAME (`"<Base> — <Table>"`);
// the adapter recovers `{ baseId, tableId }` from it privately. These prove the
// name routes to the right base/table on read, and an unknown name degrades
// gracefully (read) / fails loud (write) without any magic-string codec.

describe('Airtable name → structured-id routing', () => {
  it('routes a NAMED recordType to its base/table on a read', async () => {
    const { adapter, calls } = makeAdapter({
      records: [{ id: 'recA', fields: { fldName: 'Acme' } }],
    });
    await adapter.resolveEntity({
      record: { Name: 'Acme' },
      recordType: DEALS_TYPE,
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Name' }] }] } as never,
    });
    // The name resolved to the Deals base/table — never an encoded string.
    expect(calls.listRecords[0].baseId).toBe(BASE_ID);
    expect(calls.listRecords[0].tableId).toBe(TABLE_ID);
  });

  it('degrades to no candidates for an unknown recordType name (read)', async () => {
    const { adapter, calls } = makeAdapter({ records: [] });
    const result = await adapter.resolveEntity({
      record: { Name: 'Acme' },
      recordType: 'Nonexistent',
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Name' }] }] } as never,
    });
    expect(result.candidates).toHaveLength(0);
    expect(calls.listRecords).toHaveLength(0);
  });

  it('fails loud for an unknown recordType name (write)', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.createRecord({
        recordType: 'Nonexistent',
        fields: { Name: 'x' },
        mutationContext: {} as never,
      }),
    ).rejects.toThrow(/unrecognised recordType/);
  });
});

// ---------------------------------------------------------------------------
// 2. coerceAirtableValue
// ---------------------------------------------------------------------------

describe('coerceAirtableValue', () => {
  it('coerces numeric types via Number()', () => {
    expect(coerceAirtableValue('42', 'currency')).toBe(42);
    expect(coerceAirtableValue(7, 'number')).toBe(7);
    expect(coerceAirtableValue('not-a-number', 'rating')).toBeNull();
  });

  it('coerces checkbox truthiness strings', () => {
    expect(coerceAirtableValue('yes', 'checkbox')).toBe(true);
    expect(coerceAirtableValue('1', 'checkbox')).toBe(true);
    expect(coerceAirtableValue('no', 'checkbox')).toBe(false);
    expect(coerceAirtableValue(true, 'checkbox')).toBe(true);
  });

  it('splits a comma string into an array for multipleSelects', () => {
    expect(coerceAirtableValue('a, b,c', 'multipleSelects')).toEqual(['a', 'b', 'c']);
    expect(coerceAirtableValue(['x'], 'multipleSelects')).toEqual(['x']);
  });

  it('normalises a date/dateTime value to ISO', () => {
    expect(coerceAirtableValue('2026-06-18', 'date')).toBe('2026-06-18T00:00:00.000Z');
    expect(coerceAirtableValue(new Date('2026-06-18T00:00:00Z'), 'dateTime')).toBe(
      '2026-06-18T00:00:00.000Z',
    );
    // unparseable date passes through untouched
    expect(coerceAirtableValue('not-a-date', 'date')).toBe('not-a-date');
  });

  it('passes strings + unknown types through unchanged', () => {
    expect(coerceAirtableValue('hello', 'singleLineText')).toBe('hello');
    expect(coerceAirtableValue('v', undefined)).toBe('v');
  });
});

// ---------------------------------------------------------------------------
// 3. describe
// ---------------------------------------------------------------------------

describe('AirtableAdapter.describe', () => {
  it('maps fields, references, and writable flags', async () => {
    const { adapter } = makeAdapter();
    // describe is reached by the table's NATURAL name now (== its typeId).
    const descriptor = await adapter.describe(DEALS_TYPE);
    expect(descriptor).not.toBeNull();
    expect(descriptor!.displayName).toBe('Deals');
    expect(descriptor!.labelTemplate).toBe('{fldName}');
    expect(descriptor!.uniquenessConstraints).toBeUndefined();

    const byId = new Map(descriptor!.fields.map((f) => [f.fieldId, f]));
    expect(byId.get('fldName')!.kind).toBe('string');
    expect(byId.get('fldName')!.writable).toBe(true);
    expect(byId.get('fldAmount')!.kind).toBe('number');
    expect(byId.get('fldClosed')!.kind).toBe('boolean');
    expect(byId.get('fldTags')!.kind).toBe('enum');
    expect(byId.get('fldTags')!.cardinality).toBe('many');
    expect(byId.get('fldTags')!.enumValues).toEqual(['Hot', 'Warm']);
    expect(byId.get('fldStage')!.kind).toBe('enum');
    expect(byId.get('fldStage')!.cardinality).toBe('one');
    expect(byId.get('fldStage')!.enumValues).toEqual(['Open', 'Won']);
    // A select with no choices stays text: an empty enum would refuse every value.
    expect(byId.get('fldRegion')!.kind).toBe('string');
    expect(byId.get('fldRegion')!.enumValues).toBeUndefined();
    expect(byId.get('fldSource')!.kind).toBe('string');
    expect(byId.get('fldSource')!.cardinality).toBe('many');
    expect(byId.get('fldSource')!.enumValues).toBeUndefined();
    expect(byId.get('fldCreated')!.kind).toBe('date');
    // Read-only field types are surfaced but writable:false.
    expect(byId.get('fldCreated')!.writable).toBe(false);
    expect(byId.get('fldFormula')!.writable).toBe(false);
    // multipleAttachments is a first-class, WRITABLE File field.
    expect(byId.get('fldDeck')!.kind).toBe('file');
    expect(byId.get('fldDeck')!.cardinality).toBe('many');
    expect(byId.get('fldDeck')!.writable).toBe(true);

    // multipleRecordLinks becomes a reference to the linked table's NAME.
    expect(descriptor!.references).toHaveLength(1);
    const ref = descriptor!.references[0];
    expect(ref.fieldId).toBe('fldOwner');
    expect(ref.targetTypeId).toBe(PEOPLE_TYPE);
  });

  it('returns null for a foreign / unknown type name', async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.describe('attio:companies')).toBeNull();
    expect(await adapter.describe('Missing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. resolveEntity — exact-branch filterByFormula
// ---------------------------------------------------------------------------

// One uniqueness constraint = an AND of `{ field, fuzzy? }` entries. The
// opaque shape is OR-of-AND, so the helper wraps the single AND-branch.
function constraints(entries: Array<{ fieldId: string; fuzzy?: boolean }>): ResolveEntityInput['constraints'] {
  return {
    any: [{ all: entries.map((e) => ({ field: e.fieldId, fuzzy: e.fuzzy })) }],
  };
}

describe('AirtableAdapter.resolveEntity', () => {
  it('builds a {fieldName} = "value" formula from an exact constraint and attributes exactness', async () => {
    const { adapter, calls } = makeAdapter({
      records: [{ id: 'recA', fields: { fldName: 'Acme', fldAmount: 100 } }],
    });
    const input: ResolveEntityInput = {
      // NATURAL currency: type displayName + field displayNames (the Airtable
      // field names). The adapter resolves them to the encoded typeId + `fld…`
      // ids before the record layer runs.
      record: { Name: 'Acme' },
      recordType: DEALS_TYPE,
      candidates: [],
      constraints: constraints([{ fieldId: 'Name' }]) as unknown as ResolveEntityInput['constraints'],
    };
    const result = await adapter.resolveEntity(input);

    // The formula uses the field NAME, not the id, and exact equality.
    expect(calls.listRecords).toHaveLength(1);
    expect(calls.listRecords[0].filterByFormula).toBe('{Name} = "Acme"');

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].externalId).toBe('recA');
    // data is keyed by field name.
    expect(result.candidates[0].data.Name).toBe('Acme');
  });

  it('ANDs multi-entry branches and marks fuzzy entries non-exact', async () => {
    const { adapter, calls } = makeAdapter({ records: [] });
    const input: ResolveEntityInput = {
      record: { Name: 'Acme', Amount: 100 },
      recordType: DEALS_TYPE,
      candidates: [],
      constraints: constraints([
        { fieldId: 'Name', fuzzy: true },
        { fieldId: 'Amount' },
      ]) as unknown as ResolveEntityInput['constraints'],
    };
    await adapter.resolveEntity(input);
    expect(calls.listRecords[0].filterByFormula).toBe('AND({Name} = "Acme",{Amount} = "100")');
  });

  it('escapes quotes/backslashes in constraint values', async () => {
    const { adapter, calls } = makeAdapter({ records: [] });
    const input: ResolveEntityInput = {
      record: { Name: 'A "quoted" \\ name' },
      recordType: DEALS_TYPE,
      candidates: [],
      constraints: constraints([{ fieldId: 'Name' }]) as unknown as ResolveEntityInput['constraints'],
    };
    await adapter.resolveEntity(input);
    expect(calls.listRecords[0].filterByFormula).toBe('{Name} = "A \\"quoted\\" \\\\ name"');
  });

  it('prefers a linked_object bridge over a constraint search', async () => {
    const { adapter, calls } = makeAdapter({ records: [] });
    const input: ResolveEntityInput = {
      record: { Name: 'Acme' },
      recordType: DEALS_TYPE,
      candidates: [
        {
          node_id: 'node-1',
          external_id: 'recBRIDGED',
          // `external_object_type` is the record-type label the engine persisted
          // when it bridged this record — the position's recordType, which is
          // the pretty NAME now (the engine speaks natural names end-to-end).
          external_object_type: DEALS_TYPE,
          created_at: new Date(),
        } as unknown as ResolveEntityInput['candidates'][number],
      ],
      constraints: constraints([{ fieldId: 'Name' }]) as unknown as ResolveEntityInput['constraints'],
    };
    const result = await adapter.resolveEntity(input);
    expect(calls.listRecords).toHaveLength(0); // bridge short-circuits the search
    // The bridge candidate carries the external id; the KG node is no longer
    // surfaced per-candidate (the engine derives the bridge from externalId).
    expect(result.candidates[0].externalId).toBe('recBRIDGED');
  });
});

// ---------------------------------------------------------------------------
// 5. createRecord — read-only filtering + coercion
// ---------------------------------------------------------------------------

describe('AirtableAdapter.createRecord', () => {
  it('filters read-only fields and coerces values to their field type', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.createRecord({
      // NATURAL currency: type displayName + field displayNames (the Airtable
      // field names). The adapter resolves each to its internal `fld…` id
      // before the write builder coerces + filters read-only fields.
      recordType: DEALS_TYPE,
      fields: {
        Name: 'New Deal',
        Amount: '250', // currency → Number
        Closed: 'yes', // checkbox → true
        Score: 'computed', // formula → read-only → dropped
        Created: '2026-01-01', // createdTime → read-only → dropped
        // No such field on the table — an unmapped name falls through
        // unresolved; its null value is dropped regardless.
        fldNull: null, // null → dropped
      },
      mutationContext: {} as never,
    });

    expect(calls.createRecord).toHaveLength(1);
    const written = calls.createRecord[0].fields;
    expect(written.fldName).toBe('New Deal');
    expect(written.fldAmount).toBe(250);
    expect(written.fldClosed).toBe(true);
    expect(written).not.toHaveProperty('fldFormula');
    expect(written).not.toHaveProperty('fldCreated');
    expect(written).not.toHaveProperty('fldNull');

    expect(result.externalId).toBe('recNEW01');
    // buildRecordData surfaces a flat {name, url}.
    expect(result.data!.url).toBe(`https://airtable.com/${BASE_ID}/${TABLE_ID}/recNEW01`);
    expect(result.data!.name).toBe('New Deal');
  });
});

// ---------------------------------------------------------------------------
// 6. Link-field resolution — element-wise (ids pass through, names resolve)
// ---------------------------------------------------------------------------

describe('AirtableAdapter link-field write resolution', () => {
  const people = [{ id: 'recAlice', fields: { 'Full Name': 'Alice' } }];

  it('resolves a link NAME to a record id', async () => {
    const { adapter, calls } = makeAdapter({ records: people });
    await adapter.createRecord({
      recordType: DEALS_TYPE,
      fields: { Name: 'D', Owner: ['Alice'] },
      mutationContext: {} as never,
    });
    expect(calls.createRecord[0].fields.fldOwner).toEqual(['recAlice']);
  });

  it('handles a MIXED list (record ids + names) and de-dupes — the shape a `+:` append hands the adapter', async () => {
    const { adapter, calls } = makeAdapter({ records: people });
    await adapter.createRecord({
      recordType: DEALS_TYPE,
      // recBob is already-resolved (passes through); Alice is a name (resolves);
      // recBob is duplicated (de-duped). This is exactly current-ids ++ new-name.
      fields: { Name: 'D', Owner: ['recBob', 'Alice', 'recBob'] },
      mutationContext: {} as never,
    });
    expect(calls.createRecord[0].fields.fldOwner).toEqual(['recBob', 'recAlice']);
  });

  it('a pure list of already-resolved ids passes through (no lookup)', async () => {
    const { adapter, calls } = makeAdapter({ records: people });
    await adapter.createRecord({
      recordType: DEALS_TYPE,
      fields: { Name: 'D', Owner: ['recX', 'recY'] },
      mutationContext: {} as never,
    });
    expect(calls.createRecord[0].fields.fldOwner).toEqual(['recX', 'recY']);
    expect(calls.listRecords).toHaveLength(0); // no name to resolve
  });
});

// ---------------------------------------------------------------------------
// 7. Attachment write — FileRef → Airtable [{ url, filename }]
// ---------------------------------------------------------------------------

describe('AirtableAdapter attachment write', () => {
  it('exposes a FileRef\'s bytes at a Listen-Fire URL and maps it to an Airtable attachment object', async () => {
    const { adapter, calls } = makeAdapter();
    const store = testFileStore();
    await adapter.createRecord({
      recordType: DEALS_TYPE,
      fields: {
        Name: 'D',
        Deck: [store.file('pdf-bytes', { name: 'deck.pdf', contentType: 'application/pdf' })],
      },
      mutationContext: {} as never,
    });
    expect(calls.createRecord[0].fields.fldDeck).toEqual([
      { url: 'https://example.test/api/files/blob/blob-1', filename: 'deck.pdf' },
    ]);
  });

  it('drops an unresolvable file (no URL) and leaves the field unwritten rather than clearing it', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.createRecord({
      recordType: DEALS_TYPE,
      fields: { Name: 'D', Deck: [{ name: 'no-url.pdf' }] },
      mutationContext: {} as never,
    });
    expect(calls.createRecord[0].fields).not.toHaveProperty('fldDeck');
  });
});

// ---------------------------------------------------------------------------
// 8. getRelated — landings are stamped with the linked table's NAME
// ---------------------------------------------------------------------------
// Proves an EMITTED position carries the linked table's pretty displayName
// (`"People"`) rather than an encoded id — so a chained hop resolves it
// straight back through the same name → structured-id cache.

// ---------------------------------------------------------------------------
// 9. Entry-position (`base:`) scoping — the large-workspace escape hatch
// ---------------------------------------------------------------------------
// Positioning at a base narrows introspection to that ONE base, so a big
// workspace's tables surface without walking every base. Unpositioned keeps the
// pre-existing full-workspace walk (no migration pressure on existing
// movements). The `base:` value enum is the `Base` collection off the meta root.


describe('AirtableAdapter entry-position (base) scoping', () => {
  const crm = () => ({ id: 'appCRM01', name: 'CRM', tables: [dealsTable()] });
  const ops = () => ({ id: 'appOPS01', name: 'Ops', tables: [tasksTable()] });

  // Two bases hold different tables, so they are two TYPES, not two instances
  // of one — each gets its own type-edge off the root, and the tables live
  // behind them. plans/2026-07-10-adapter-entry-positions/2_type_space.md.
  it('unpositioned → the `Bases` edge, and nothing walked at all', async () => {
    const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
      teamId: 'team-air-full',
      bases: [crm(), ops()],
    });
    const entries = await adapter.listEntryPoints();
    // `Bases` is the ONE presentation of the bases: narrowing (`WHERE b.Name
    // == …`) replaces naming. A table, its changes and the row a change is
    // about are named for the resolver, listed by nothing.
    expect(entries.map((e) => [e.collectionName ?? e.displayName, e.readable])).toEqual([['Bases', true], ['Table', false], ['Change', false], ['Row', false]]);
    // Both entries are static facts, so the unpositioned root walks NOTHING —
    // not even `listBases` (the walk pays that when someone follows the edge).
    expect(listedTableBaseIds).toEqual([]);
  });

  it('a base is readable but never writable — you write a row, not a base', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-rw', bases: [crm(), ops()] });
    const entries = await adapter.listEntryPoints();
    const bases = entries.filter((e) => e.collectionName === 'Bases');
    expect(bases.every((e) => e.readable && !e.writable)).toBe(true);
    // Listed again on a clock: Airtable reports no base made or renamed.
    expect(bases[0]).toMatchObject({ membersChange: { relistEverySeconds: 3600 } });
  });

  // A table's changes are announced, never listed: a webhook per table
  // delivers them, and a base's tables are listed cheaply and their changes
  // reported by a schema webhook per base, so a listen narrowed by them is
  // listed again on each.
  it('a table\'s Changes are only announced, and a base\'s Tables report their own changes', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-ev', bases: [crm(), ops()] });
    const base = await adapter.describe('Base');
    expect(base?.references.find((r) => r.name === 'Tables')).toMatchObject({
      targetTypeId: 'Table', readable: true, membersChange: 'pushed', listenable: true, delivery: 'scope', identity: 'Id',
    });
    const table = await adapter.describe('Table');
    expect(table?.fields.map((f) => f.fieldId)).toEqual(['Name', 'Id']);
    // A change carries its base and table, so a listen narrowed by them is
    // judged from the arrival, by a host that lists neither.
    expect(table?.references.find((r) => r.name === 'Changes')).toMatchObject({
      targetTypeId: 'Change', readable: false, listenable: true, delivery: 'scope', identity: 'Id', attributes: true, carries: ['Bases', 'Tables'],
    });
    const change = await adapter.describe('Change');
    expect(change?.fields.map((f) => f.fieldId)).toEqual(['Id', 'Kind', 'Current', 'Previous', 'Changed Fields', 'Base Id', 'Table Id', 'Record Id']);
    expect(change?.fields.find((f) => f.fieldId === 'Changed Fields')).toMatchObject({ kind: 'string', cardinality: 'many', required: true });
    expect(change?.fields.find((f) => f.fieldId === 'Kind')?.enumValues).toEqual(['created', 'updated', 'deleted']);
    // The row before and after is held as a value, read through; the row now is an edge, a read.
    expect(change?.fields.find((f) => f.fieldId === 'Current')).toMatchObject({ kind: 'record', record: { typeId: 'Row' }, mayBeAbsent: true });
    expect(change?.references.map((r) => [r.name, r.targetTypeId, r.readable])).toEqual([['Record', 'Row', true]]);
  });

  it('positioned at a base → only that base\'s tables, and only that base is walked', async () => {
    const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
      teamId: 'team-air-pos',
      bases: [crm(), ops()],
      base: 'Ops',
    });
    const entries = await adapter.listEntryPoints();
    // The base's own `Tables`, reported to the connection, beside its tables.
    expect(entries.map((e) => e.collectionName ?? e.displayName)).toEqual(['Tables', 'Change', 'Row', 'Tasks']);
    expect(entries[0]).toMatchObject({ readable: true, listenable: true, membersChange: 'pushed', delivery: 'connection' });
    expect(entries[3].externalId).toBe('tblTASKS01');
    // The other base's tables were never enumerated — this is the timeout fix.
    expect(listedTableBaseIds).toEqual(['appOPS01']);
    // No `Bases` hop comes before it here: it declares its table alone.
    const table = await adapter.describe('Table');
    expect(table?.references.find((r) => r.name === 'Changes')).toMatchObject({ delivery: 'connection', carries: ['Tables'] });
  });

  it('resolves the base name case-insensitively', async () => {
    const { adapter } = makeMultiBaseAdapter({
      teamId: 'team-air-ci',
      bases: [crm(), ops()],
      base: '  ops  ',
    });
    const entries = await adapter.listEntryPoints();
    expect(entries.map((e) => e.collectionName ?? e.displayName)).toEqual(['Tables', 'Change', 'Row', 'Tasks']);
  });

  it('positioned at an UNKNOWN base → falls back to the unpositioned root', async () => {
    const { adapter } = makeMultiBaseAdapter({
      teamId: 'team-air-unknown',
      bases: [crm(), ops()],
      base: 'Nonexistent',
    });
    // A name that resolves to no base leaves the cursor at the root, so the
    // author sees the `Base` collection and can narrow to a real one. (The
    // checker warns on the unknown name separately — an introspection miss
    // must not block.)
    const entries = await adapter.listEntryPoints();
    expect(entries.map((e) => e.collectionName ?? e.displayName)).toEqual(['Bases', 'Table', 'Change', 'Row']);
  });

  // The drill-down: describe the connection → the bases; follow one → its
  // tables; follow a table → its fields. Each hop is ONE upstream call
  // answering exactly what was asked.
  // plans/2026-07-10-adapter-entry-positions/3_edges_from.md
  describe('edgesFrom — the meta-graph walk', () => {
    it('root hop → ONE polymorphic edge whose members carry the paths on', async () => {
      const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
        teamId: 'team-air-walk-root',
        bases: [crm(), ops()],
      });
      const hop = await adapter.edgesFrom(makeMetaPosition('airtable'));

      // The named per-base edges are gone from the presentation; the members
      // ride `targetPositions` with no reference row each.
      expect(hop?.descriptor.references.map((r) => [r.name, r.targetTypeId])).toEqual([['Bases', 'Base']]);
      // You traverse a base; you never write one. An absent flag would
      // default to a write claim the entry list denies.
      const baseRef = hop?.descriptor.references.find((r) => r.targetTypeId === 'Base');
      expect(baseRef?.writable).toBe(false);
      // The path is what makes the next hop one call rather than a re-walk.
      const path = hop?.targetPositions?.appCRM01;
      expect(path?.recordType).toBe('Base');
      expect(path?.identity.kind === 'stable' && path.identity.recordId).toBe('appCRM01');
      // A member's `Name` label is what narrows it AND what names it.
      expect(path?.identity.kind === 'stable' && path.identity.data).toEqual({
        Name: 'CRM',
        Id: 'appCRM01',
      });
      expect(listedTableBaseIds).toEqual([]);
    });

    it('base hop → its tables, and touches ONLY that base', async () => {
      const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
        teamId: 'team-air-walk-base',
        bases: [crm(), ops()],
      });
      const hop = await adapter.edgesFrom(
        makeStablePosition({ adapterType: 'airtable', recordType: 'Base', recordId: 'appCRM01' }),
      );

      expect(hop?.descriptor.displayName).toBe('CRM');
      expect(hop?.descriptor.references.map((r) => r.targetTypeId)).toEqual(['Deals', 'Table']);
      // Mid-walk, a table is traversed AND written: `createRecord` resolves
      // the table by its own name, so a walked-to table is exactly as
      // writable as a positioned root's. Unpositioned, this edge is the ONLY
      // place a row create can be authored — the root publishes only `Base`.
      expect(hop?.descriptor.references[0]?.writable).toBe(true);
      // The whole point: `Ops` is never walked.
      expect(listedTableBaseIds).toEqual(['appCRM01']);
      // The table's path carries its baseId — a table is only reachable
      // through its base, so its path must say which one — plus the two ways
      // the table is ADDRESSED: `Id` is how a LISTEN names it (`table:
      // "tblDEALS01"`), `Name` how a movement does. A narrowing predicate
      // evaluates over exactly this data, so an unpublished field is a field
      // nothing can narrow on.
      const path = hop?.targetPositions?.tblDEALS01;
      expect(path?.recordType).toBe('Table');
      expect(path?.identity.kind === 'stable' && path.identity.data).toEqual({
        baseId: 'appCRM01',
        Id: 'tblDEALS01',
        Name: 'Deals',
      });
    });

    it('table hop → its fields, routed off the path with no workspace walk', async () => {
      const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
        teamId: 'team-air-walk-table',
        bases: [crm(), ops()],
      });
      const hop = await adapter.edgesFrom(
        makeStablePosition({
          adapterType: 'airtable',
          recordType: 'Table',
          recordId: 'tblDEALS01',
          data: { baseId: 'appCRM01' },
        }),
      );

      expect(hop?.descriptor.displayName).toBe('Deals');
      expect(hop?.descriptor.fields.length).toBeGreaterThan(0);
      // Reached as one of a base's `Tables`, it is still a table: a listen
      // narrowed to it goes on to its `Changes`.
      // narrowed to it goes on to its own `Changes`, whose rows are its rows.
      expect(hop?.descriptor.references.find((r) => r.name === 'Changes')?.targetTypeId).toBe('Deals Change');
      // Describing this table BY NAME would have walked every base to map the
      // name back to {baseId, tableId}. The path already said.
      expect(listedTableBaseIds).toEqual(['appCRM01']);

      // The path on to its changes, and from them back to the table their rows are of.
      const changes = hop?.targetPositions?.Changes;
      expect(changes?.recordType).toBe('Change');
      const changeHop = changes === undefined ? null : await adapter.edgesFrom(changes);
      expect(changeHop?.descriptor.displayName).toBe('Deals Change');
      expect(changeHop?.descriptor.fields.filter((f) => f.kind === 'record').map((f) => [f.fieldId, f.record?.typeId, f.mayBeAbsent])).toEqual([
        ['Current', 'Deals', true],
        ['Previous', 'Deals', true],
      ]);
      expect(changeHop?.descriptor.references.map((r) => [r.name, r.targetTypeId])).toEqual([['Record', 'Deals']]);
      const row = changeHop?.targetPositions?.Record;
      expect([row?.recordType, row?.identity.kind === 'stable' && row.identity.data]).toEqual(['Table', { baseId: 'appCRM01', Id: 'tblDEALS01', Name: 'Deals' }]);
    });

    it('positioned at a base → the ROOT publishes its tables (construction walked us there)', async () => {
      const { adapter } = makeMultiBaseAdapter({
        teamId: 'team-air-walk-positioned',
        bases: [crm(), ops()],
        base: 'Ops',
      });
      const hop = await adapter.edgesFrom(makeMetaPosition('airtable'));

      // The base's own `Tables` rides the positioned root, reported to the
      // connection — and the entry list publishes it there too. Same node,
      // same edges.
      expect(hop?.descriptor.references.map((r) => [r.targetTypeId, r.delivery])).toEqual([
        ['Tasks', undefined], ['Table', 'connection'],
      ]);
      // A POSITIONED root's tables are its writable roots — the entry list
      // says `writable: true` for the same edges (the write gate), and the
      // walk must not disagree with it.
      const tasks = hop?.descriptor.references.find((r) => r.targetTypeId === 'Tasks');
      expect(tasks?.writable).toBe(true);
    });

    it('an unrecognised position is null, like an unknown typeId', async () => {
      const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-walk-null', bases: [crm()] });
      const hop = await adapter.edgesFrom(
        makeStablePosition({ adapterType: 'airtable', recordType: 'Base', recordId: 'appNOPE' }),
      );
      expect(hop).toBeNull();
    });
  });

  // An adapter that publishes `readable: true` and then can't read is a lie.
  // Both container reads were published and neither worked: the root threw (a
  // meta position isn't a record) and a base's silently returned nothing.
  describe('collection reads from a container', () => {
    it('reads a table from the ROOT of a base-positioned instance', async () => {
      const { adapter } = makeMultiBaseAdapter({
        teamId: 'team-air-coll-root',
        bases: [crm(), ops()],
        base: 'CRM',
        records: [{ id: 'rec1', fields: { Name: 'Acme' } }],
      });
      const landings = await adapter.getRelated({
        position: makeMetaPosition('airtable'),
        fieldId: 'Deals',
        direction: 'outgoing',
      });
      expect(landings.map((l) => l.position.recordType)).toEqual(['Deals']);
      expect(landings[0].position.identity.kind === 'stable' && landings[0].position.identity.recordId).toBe('rec1');
    });

    it('reads a table from a BASE reached by traversal', async () => {
      const { adapter } = makeMultiBaseAdapter({
        teamId: 'team-air-coll-base',
        bases: [crm(), ops()],
        records: [{ id: 'rec1', fields: { Name: 'Acme' } }],
      });
      // `-[b:Base WHERE `Name` == "CRM"]->-[d:`Deals`]->` at runtime.
      const landings = await adapter.getRelated({
        position: makeStablePosition({
          adapterType: 'airtable',
          recordType: 'Base',
          recordId: 'appCRM01',
          data: { Name: 'CRM' },
        }),
        fieldId: 'Deals',
        direction: 'outgoing',
      });
      expect(landings.map((l) => l.position.recordType)).toEqual(['Deals']);
    });

    it('an unknown collection is empty, not a throw', async () => {
      const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-coll-nope', bases: [crm()], base: 'CRM' });
      expect(
        await adapter.getRelated({
          position: makeMetaPosition('airtable'),
          fieldId: 'Nonexistent',
          direction: 'outgoing',
        }),
      ).toEqual([]);
    });
  });

  // `listEntryPoints` IS `edgesFrom(meta)` — the same node's edges — so they
  // must publish the same EDGES with the same PROMISES. Disagreement here is
  // the unchecked-default class the explorer flags: an absent flag on a walk
  // ref defaults to a claim the entry list denies.
  // plans/2026-07-10-adapter-entry-positions/4_polymorphic_edges.md
  it('the entry list and the walk agree on the root\'s edges AND their promises', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-agree', bases: [crm(), ops()] });
    const entries = (await adapter.listEntryPoints()).filter((e) => e.readable || e.writable).map((e) => ({
      name: e.collectionName ?? e.displayName,
      readable: e.readable === true,
      writable: e.writable === true,
    }));
    const hop = await adapter.edgesFrom(makeMetaPosition('airtable'));
    const walk = (hop?.descriptor.references ?? []).map((r) => ({
      name: r.name ?? r.fieldId,
      readable: r.readable !== false,
      writable: r.writable === true,
    }));
    expect(walk).toEqual(entries);
    expect(entries.map((e) => e.name)).toEqual(['Bases']);
  });

  it('an unknown name off the UNPOSITIONED root is empty — never a workspace walk', async () => {
    const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
      teamId: 'team-air-named',
      bases: [crm(), ops()],
    });
    // The named per-base edges are gone: `CRM` is not an edge off the root any
    // more. Narrowing (`-[b:Bases WHERE b.Name == "CRM"]->`) is the route.
    const landings = await adapter.getRelated({
      position: makeMetaPosition('airtable'),
      fieldId: 'CRM',
      direction: 'outgoing',
    });
    expect(landings).toEqual([]);
    expect(listedTableBaseIds).toEqual([]);
  });

  it('publishes ONE presentation of a base — the narrowable `Bases` edge', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-both', bases: [crm(), ops()] });
    const entries = await adapter.listEntryPoints();
    // The named spelling was dropped (2026-07-17): it added nothing the
    // narrowable edge doesn't say, and layer 4's steer is that the
    // polymorphic form reads better for containers.
    expect(entries.filter((e) => e.readable).map((e) => e.typeId)).toEqual(['Base']);
    // Unnarrowed, a Base has its Name, its Id and its `Tables`, and none by
    // name — which tables exist depends on which base, and nobody has said
    // yet. Name and Id are what a narrowing predicate reads.
    const base = await adapter.describe('Base');
    expect(base?.references.map((r) => r.name)).toEqual(['Tables']);
    expect(base?.fields.map((f) => f.fieldId)).toEqual(['Name', 'Id']);
    expect(base?.description).toContain('Narrow');
  });

  it('a base is still describable BY NAME — the node narrowing lands on', async () => {
    const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({
      teamId: 'team-air-desc-name',
      bases: [crm(), ops()],
    });
    // `refineInstanceSchema` describes the member a predicate selected by its
    // label — this is that call, and it must cost ONE base's walk.
    const descriptor = await adapter.describe('CRM');
    expect(descriptor?.displayName).toBe('CRM');
    expect(descriptor?.references.map((r) => r.name)).toEqual(['Deals', 'Tables']);
    expect(listedTableBaseIds).toEqual(['appCRM01']);
  });

  it('projects the `Bases` collection off the meta root, labelled by name (the `base:` value enum)', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-bases', bases: [crm(), ops()] });
    const results = await adapter.getRelated({
      position: makeMetaPosition('airtable'),
      fieldId: 'Bases',
      direction: 'outgoing',
    });
    expect(results.map((r) => r.position.recordType)).toEqual(['Base', 'Base']);
    const labels = results
      .map((r) => (positionData(r.position) as { Name: string }).Name)
      .sort();
    expect(labels).toEqual(['CRM', 'Ops']);
  });
});

describe('AirtableAdapter.getRelated', () => {
  it('emits a landing typed by the linked table displayName', async () => {
    const { adapter } = makeAdapter({
      records: [{ id: 'recAlice', fields: { 'Full Name': 'Alice' } }],
    });
    const results = await adapter.getRelated({
      // A Deals position whose `Owner` link holds one People record id.
      position: makeStablePosition({
        adapterType: 'airtable',
        recordType: DEALS_TYPE,
        recordId: 'recDeal1',
        data: { Owner: ['recAlice'] },
      }),
      fieldId: 'Owner',
      direction: 'outgoing',
    });
    expect(results).toHaveLength(1);
    expect(results[0].position.recordType).toBe(PEOPLE_TYPE);
  });
});

// The event node and the row are DIFFERENT NODES. This adapter used to seed the
// row AS the event, which is why a movement could declare `<at-[:`Deals`]->>` and
// have nothing check it. The `record` edge is what un-conflates them.
// plans/2026-07-10-adapter-entry-positions/8_event_edges.md
describe('a change → its record', () => {
  const crm = () => ({ id: 'appCRM01', name: 'CRM', tables: [dealsTable()] });
  const change = (data: unknown) => makeUnstablePosition({ adapterType: 'airtable', recordType: 'Change', data });
  const updated = {
    Id: '7:recOLD01',
    Kind: 'updated',
    Current: { Name: 'Acme', Stage: 'Seed' },
    Previous: { Name: 'Acme', Stage: 'Lead' },
    row: { id: 'recOLD01', baseId: 'appCRM01', tableId: 'tblDEALS01', table: 'Deals' },
  };

  it('reads the row as it is now, typed by its table, not as the change left it', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-change-rec', bases: [crm()], records: [{ id: 'recOLD01', fields: { Name: 'Acme', Stage: 'Won' } }] });
    const results = await adapter.getRelated({ position: change(updated), fieldId: 'Record', direction: 'outgoing' });
    expect(results.map((r) => [r.position.recordType, r.position.identity.kind === 'stable' && r.position.identity.recordId, positionData(r.position)])).toEqual([
      ['Deals', 'recOLD01', { Name: 'Acme', Stage: 'Won' }],
    ]);
  });

  it('a row deleted since is none', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-change-del', bases: [crm()] });
    const deleted = { Id: '8:recOLD01', Kind: 'deleted', row: updated.row };
    expect(await adapter.getRelated({ position: change(deleted), fieldId: 'Record', direction: 'outgoing' })).toEqual([]);
  });
});

// A payload as its arrivals: each row's change on its table's `Changes` (an
// update one per field it touched), each table made, renamed or removed on
// its base's `Tables`. A change is named by its transaction and what it
// touched, so a payload pulled again names the same changes.
describe('arrivalsFromPayload', () => {
  const context = (positioned: boolean) => ({
    baseId: 'appCRM01',
    baseName: 'CRM',
    positioned,
    tableNamesById: new Map([['tblDEALS01', 'Deals']]),
    fieldsByTable: new Map([
      ['tblDEALS01', new Map([['fldNAME', { name: 'Name', type: 'singleLineText' }], ['fldSTAGE', { name: 'Stage', type: 'singleSelect' }]])],
    ]),
  });

  it('a row created, one updated in two fields and one deleted are three changes, one per row, each with the row before and after', () => {
    const arrivals = arrivalsFromPayload(
      {
        timestamp: '2026-11-01T09:00:00.000Z',
        baseTransactionNumber: 7,
        changedTablesById: {
          tblDEALS01: {
            createdRecordsById: { recNEW01: { cellValuesByFieldId: { fldNAME: 'Acme', fldSTAGE: { id: 'selI', name: 'Interview' } } } },
            changedRecordsById: {
              recOLD01: {
                current: { cellValuesByFieldId: { fldNAME: 'Beta', fldSTAGE: { id: 'selW', name: 'Won' } } },
                previous: { cellValuesByFieldId: { fldNAME: 'Alpha', fldSTAGE: { id: 'selS', name: 'Seed' } } },
                unchanged: { cellValuesByFieldId: { fldOWNER: 'Ada' } },
              },
            },
            destroyedRecordIds: ['recGONE'],
          },
        },
      },
      context(false),
    );
    expect(arrivals.map((a) => [a.edge, a.key, a.identity, a.landing.recordType, a.landing.fields.Kind, a.landing.fields.Current, a.landing.fields.Previous])).toEqual([
      ['Changes', 'tblDEALS01', '7:recNEW01', 'Change', 'created', { Name: 'Acme', Stage: 'Interview' }, undefined],
      ['Changes', 'tblDEALS01', '7:recOLD01', 'Change', 'updated', { fldOWNER: 'Ada', Name: 'Beta', Stage: 'Won' }, { fldOWNER: 'Ada', Name: 'Alpha', Stage: 'Seed' }],
      ['Changes', 'tblDEALS01', '7:recGONE', 'Change', 'deleted', undefined, undefined],
    ]);
    expect(arrivals.map((a) => a.about)).toEqual([
      { recordType: 'Deals', externalId: 'recNEW01' },
      { recordType: 'Deals', externalId: 'recOLD01' },
      { recordType: 'Deals', externalId: 'recGONE' },
    ]);
    expect(arrivals.every((a) => a.occurredAt === '2026-11-01T09:00:00.000Z')).toBe(true);
    // What the edit touched, as 0.12's `Changed Fields` named it, and the ids a program reads (a deleted row's too).
    expect(arrivals.map((a) => [a.landing.fields['Changed Fields'], a.landing.fields['Base Id'], a.landing.fields['Table Id'], a.landing.fields['Record Id']])).toEqual([
      [['Name', 'Stage'], 'appCRM01', 'tblDEALS01', 'recNEW01'],
      [['Name', 'Stage'], 'appCRM01', 'tblDEALS01', 'recOLD01'],
      [[], 'appCRM01', 'tblDEALS01', 'recGONE'],
    ]);
    // The ids the `Record` edge reads the row again by.
    expect(changeDataOf(arrivals[1].landing.fields)?.row).toEqual({ id: 'recOLD01', baseId: 'appCRM01', tableId: 'tblDEALS01', table: 'Deals' });
  });

  it('a table renamed, one made and one removed arrive on the base\'s Tables, under the base unless the connection stands on it', () => {
    const payload = {
      baseTransactionNumber: 9,
      changedTablesById: { tblDEALS01: { changedMetadata: { current: { name: 'Pipeline' }, previous: { name: 'Deals' } } } },
      createdTablesById: { tblNEW01: { metadata: { name: 'Expenses' } } },
      destroyedTableIds: ['tblOLD01'],
    };
    expect(changesTables(payload)).toBe(true);
    const walked = arrivalsFromPayload(payload, context(false));
    expect(walked.map((a) => [a.edge, a.key, a.identity, a.landing.recordType, a.landing.fields])).toEqual([
      ['Tables', 'appCRM01', '9:tblDEALS01', 'Table', { Id: 'tblDEALS01', Name: 'Pipeline' }],
      ['Tables', 'appCRM01', '9:tblNEW01', 'Table', { Id: 'tblNEW01', Name: 'Expenses' }],
      ['Tables', 'appCRM01', '9:tblOLD01', 'Table', { Id: 'tblOLD01' }],
    ]);
    expect(arrivalsFromPayload(payload, context(true)).map((a) => a.key)).toEqual([undefined, undefined, undefined]);
    expect(changesTables({ changedTablesById: { tblDEALS01: { destroyedRecordIds: ['recGONE'] } } })).toBe(false);
  });

  it('a cell an update emptied is absent from the row as the edit left it, or null as Airtable held it', () => {
    const arrivals = arrivalsFromPayload(
      {
        baseTransactionNumber: 11,
        changedTablesById: {
          tblDEALS01: {
            changedRecordsById: {
              recLEFT: { current: { cellValuesByFieldId: {} }, previous: { cellValuesByFieldId: { fldSTAGE: { id: 'selS', name: 'Seed' } } }, unchanged: { cellValuesByFieldId: { fldNAME: 'Acme' } } },
              recNULL: { current: { cellValuesByFieldId: { fldSTAGE: null } }, previous: { cellValuesByFieldId: { fldSTAGE: { id: 'selS', name: 'Seed' } } }, unchanged: { cellValuesByFieldId: { fldNAME: 'Beta' } } },
            },
          },
        },
      },
      context(false),
    );
    expect(arrivals.map((a) => [a.identity, a.landing.fields.Current, a.landing.fields.Previous, a.landing.fields['Changed Fields']])).toEqual([
      ['11:recLEFT', { Name: 'Acme' }, { Name: 'Acme', Stage: 'Seed' }, ['Stage']],
      ['11:recNULL', { Name: 'Beta', Stage: null }, { Name: 'Beta', Stage: 'Seed' }, ['Stage']],
    ]);
  });

  it('every cell reads as the value its field declares, so two copies of one compare equal', () => {
    const fields = new Map<string, { name: string; type?: string }>([
      ['fldOWN', { name: 'Owner', type: 'singleCollaborator' }],
      ['fldTEAM', { name: 'Team', type: 'multipleCollaborators' }],
      ['fldBY', { name: 'Made by', type: 'createdBy' }],
      ['fldTAGS', { name: 'Tags', type: 'multipleSelects' }],
      ['fldSYNC', { name: 'Source', type: 'externalSyncSource' }],
      ['fldCODE', { name: 'Code', type: 'barcode' }],
      ['fldAI', { name: 'Summary', type: 'aiText' }],
      ['fldAIW', { name: 'Draft', type: 'aiText' }],
      ['fldGO', { name: 'Go', type: 'button' }],
      ['fldLINK', { name: 'Roles', type: 'multipleRecordLinks' }],
      ['fldLOOK', { name: 'Role titles', type: 'multipleLookupValues' }],
      ['fldSUM', { name: 'Total', type: 'formula' }],
      ['fldERR', { name: 'Broken', type: 'formula' }],
      ['fldFILES', { name: 'CV', type: 'multipleAttachments' }],
    ]);
    const ann = { id: 'usrANN', email: 'ann@example.com', name: 'Ann' };
    const cells = {
      fldOWN: { ...ann },
      fldTEAM: [{ ...ann }, { id: 'usrBO', email: 'bo@example.com', name: 'Bo' }],
      fldBY: { ...ann, profilePicUrl: 'https://x' },
      fldTAGS: [{ id: 'selA', name: 'Urgent', color: 'red' }],
      fldSYNC: { id: 'srcA', name: 'CRM', color: 'blue' },
      fldCODE: { text: '0123', type: 'upce' },
      fldAI: { state: 'generated', isStale: false, value: 'Strong' },
      fldAIW: { state: 'loading', isStale: false, value: null },
      fldGO: { label: 'Open', url: 'https://x' },
      fldLINK: [{ id: 'recR1', name: 'Engineer' }],
      fldLOOK: { valuesByLinkedRecordId: { recR2: ['Designer'], recR1: ['Engineer'] }, linkedRecordIds: ['recR1', 'recR2'] },
      fldSUM: 3,
      fldERR: { specialValue: 'NaN' },
      fldFILES: [{ id: 'att1', url: 'https://f', filename: 'cv.pdf' }],
    };
    const [arrival] = arrivalsFromPayload(
      { baseTransactionNumber: 12, changedTablesById: { tblDEALS01: { changedRecordsById: { recA: { current: { cellValuesByFieldId: {} }, unchanged: { cellValuesByFieldId: cells } } } } } },
      { baseId: 'appCRM01', positioned: false, tableNamesById: new Map([['tblDEALS01', 'Deals']]), fieldsByTable: new Map([['tblDEALS01', fields]]) },
    );
    const current = changeDataOf(arrival.landing.fields)?.Current;
    expect(current).toEqual({
      Owner: 'ann@example.com',
      Team: ['ann@example.com', 'bo@example.com'],
      'Made by': 'ann@example.com',
      Tags: ['Urgent'],
      Source: 'CRM',
      Code: '0123',
      Summary: 'Strong',
      Draft: null,
      Go: 'Open',
      Roles: ['recR1'],
      'Role titles': ['Engineer', 'Designer'],
      Total: 3,
      Broken: '{"specialValue":"NaN"}',
      CV: [{ id: 'att1', url: 'https://f', filename: 'cv.pdf' }],
    });
    // Unchanged cells are the same values in the row before and after.
    expect(changeDataOf(arrival.landing.fields)?.Previous?.Owner).toBe(current?.Owner);
  });

  it('a field with no metadata is named by its id, and the table by its id', () => {
    const arrivals = arrivalsFromPayload(
      { baseTransactionNumber: 3, changedTablesById: { tblX: { changedRecordsById: { recA: { current: { cellValuesByFieldId: { fldQ: 1 } } } } } } },
      context(false),
    );
    expect(arrivals.map((a) => [a.landing.fields.Current, a.about])).toEqual([[{ fldQ: 1 }, { recordType: 'tblX', externalId: 'recA' }]]);
    // Its table's name is not known, and says so: a listen filtering it is not judged on a guess.
    expect(arrivals[0].parents?.[1]).toEqual({ recordId: 'tblX', recordType: 'Table', fields: { Id: 'tblX' }, unknown: ['Name'] });
  });

  // A host judges a listen narrowed by base or table from the arrival alone:
  // each change carries the records the edge declares it carries, outermost first.
  it('a change carries its base and table, with their ids and names, whatever the connection stands on', () => {
    const payload = { baseTransactionNumber: 4, changedTablesById: { tblDEALS01: { createdRecordsById: { recNEW01: { cellValuesByFieldId: { fldNAME: 'Acme' } } } } } };
    const base = { recordId: 'appCRM01', recordType: 'Base', fields: { Id: 'appCRM01', Name: 'CRM' } };
    const table = { recordId: 'tblDEALS01', recordType: 'Table', fields: { Id: 'tblDEALS01', Name: 'Deals' } };
    expect(arrivalsFromPayload(payload, context(false)).map((a) => a.parents)).toEqual([[base, table]]);
    expect(arrivalsFromPayload(payload, context(true)).map((a) => a.parents)).toEqual([[base, table]]);
    // A base whose name could not be read is carried by its id, its name unknown.
    const { baseName: _unread, ...nameless } = context(false);
    expect(arrivalsFromPayload(payload, nameless)[0].parents?.[0]).toEqual({ recordId: 'appCRM01', recordType: 'Base', fields: { Id: 'appCRM01' }, unknown: ['Name'] });
    // A table's own arrival on Tables carries nothing.
    const renamed = arrivalsFromPayload({ baseTransactionNumber: 5, changedTablesById: { tblDEALS01: { changedMetadata: { current: { name: 'Pipeline' } } } } }, context(false));
    expect(renamed.map((a) => [a.edge, a.parents])).toEqual([['Tables', undefined]]);
  });
});

// At the door: each ping's changes carry their base and table by name, read
// from Airtable's meta API once per base and kept, not once per delivery.
describe('preprocessInbound', () => {
  const ping = (baseId: string) => ({ base: { id: baseId }, webhook: { id: 'achDATA01' } });
  const created = (recordId: string) => ({ baseTransactionNumber: 1, changedTablesById: { tblDEALS01: { createdRecordsById: { [recordId]: { cellValuesByFieldId: { fldName: 'Acme' } } } } } });

  it('a change arrives carrying its Base and Table, each with its Id and Name', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-door-parents', bases: [{ id: 'appHIRE01', name: 'Hiring', tables: [dealsTable()] }], payloads: [created('recA')] });
    const { arrivals } = await adapter.preprocessInbound({ raw: ping('appHIRE01') });
    expect(arrivals.map((a) => [a.edge, a.key, a.parents])).toEqual([
      [
        'Changes',
        'tblDEALS01',
        [
          { recordId: 'appHIRE01', recordType: 'Base', fields: { Id: 'appHIRE01', Name: 'Hiring' } },
          { recordId: 'tblDEALS01', recordType: 'Table', fields: { Id: 'tblDEALS01', Name: 'Deals' } },
        ],
      ],
    ]);
  });

  it('reads the names once per base, however many deliveries come for it', async () => {
    const { adapter, listedTableBaseIds, listedBases } = makeMultiBaseAdapter({
      teamId: 'team-air-door-cached',
      bases: [
        { id: 'appHIRE01', name: 'Hiring', tables: [dealsTable()] },
        { id: 'appOPS01', name: 'Ops', tables: [dealsTable()] },
      ],
      payloads: [created('recA')],
    });
    for (const baseId of ['appHIRE01', 'appHIRE01', 'appOPS01', 'appOPS01']) await adapter.preprocessInbound({ raw: ping(baseId) });
    expect(listedTableBaseIds).toEqual(['appHIRE01', 'appOPS01']);
    expect(listedBases.count).toBe(1);
  });

  it('a base made since the names were read is read again, once', async () => {
    const bases = [{ id: 'appHIRE01', name: 'Hiring', tables: [dealsTable()] }];
    const { adapter, listedBases } = makeMultiBaseAdapter({ teamId: 'team-air-door-new-base', bases, payloads: [created('recA')] });
    await adapter.preprocessInbound({ raw: ping('appHIRE01') });
    bases.push({ id: 'appNEW01', name: 'Fresh', tables: [dealsTable()] });
    const { arrivals } = await adapter.preprocessInbound({ raw: ping('appNEW01') });
    expect(arrivals[0].parents?.[0]).toEqual({ recordId: 'appNEW01', recordType: 'Base', fields: { Id: 'appNEW01', Name: 'Fresh' } });
    await adapter.preprocessInbound({ raw: ping('appNEW01') });
    expect(listedBases.count).toBe(2);
  });
});

describe('names the module keeps for itself', () => {
  const named = (name: string) => ({ ...tasksTable(), id: `tbl${name.toUpperCase()}`, name });

  it.each(['Tables', 'Change', 'Row', 'Table', 'Base'])('a base holding a table named %s is refused, walked to or positioned at', async (name) => {
    const bases = [{ id: 'appODD01', name: 'Odd', tables: [dealsTable(), named(name)] }];
    const walked = makeMultiBaseAdapter({ teamId: `team-air-reserved-walk-${name}`, bases });
    const said = `airtable: base "Odd" has a table named "${name}", a name the Airtable module gives its own (Base, Table, Change, Row, Tables), so a program could not tell which it meant: rename the table in Airtable to reach this base`;
    await expect(walked.adapter.describe('Odd')).rejects.toThrow(said);
    const base = makeStablePosition({ adapterType: 'airtable', recordType: 'Base', recordId: 'appODD01', data: { Name: 'Odd', Id: 'appODD01' } });
    await expect(walked.adapter.edgesFrom(base)).rejects.toThrow(said);
    const positioned = makeMultiBaseAdapter({ teamId: `team-air-reserved-pos-${name}`, bases, base: 'Odd' });
    await expect(positioned.adapter.listEntryPoints()).rejects.toThrow(said);
  });

  it('a base holding a table named as another table\'s changes is refused', async () => {
    const bases = [{ id: 'appODD01', name: 'Odd', tables: [dealsTable(), named('Deals Change')] }];
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-reserved-changes', bases });
    await expect(adapter.describe('Odd')).rejects.toThrow(
      'airtable: base "Odd" has a table named "Deals Change", the name the Airtable module gives another table\'s changes, so a program could not tell which it meant: rename the table in Airtable to reach this base',
    );
  });

  it('a table whose link field is named Changes is refused where it is reached as a Table', async () => {
    const linked = { ...dealsTable(), fields: [...dealsTable().fields, { id: 'fldCHG', name: 'Changes', type: 'multipleRecordLinks', options: { linkedTableId: 'tblTASKS01' } }] };
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-reserved-link', bases: [{ id: 'appCRM01', name: 'CRM', tables: [linked, tasksTable()] }] });
    const table = makeStablePosition({ adapterType: 'airtable', recordType: 'Table', recordId: 'tblDEALS01', data: { baseId: 'appCRM01', Id: 'tblDEALS01', Name: 'Deals' } });
    await expect(adapter.edgesFrom(table)).rejects.toThrow(
      'airtable: table "Deals" has a link field named "Changes", the name of a table\'s own edge to its changes, so a program could not tell which it meant: rename the field in Airtable to reach this table',
    );
  });
});

// A listen narrowed by its tables is listed again when Airtable reports one
// renamed, possibly in another process than the one the report reached: so
// a base's `Tables` is read from Airtable each time, never from the cache.
describe('a base\'s Tables', () => {
  it('are listed fresh each time, so a rename is seen at once', async () => {
    const tables = [dealsTable(), tasksTable()];
    const { adapter, listedTableBaseIds } = makeMultiBaseAdapter({ teamId: 'team-air-fresh', bases: [{ id: 'appCRM01', name: 'CRM', tables }] });
    const base = makeStablePosition({ adapterType: 'airtable', recordType: 'Base', recordId: 'appCRM01', data: { Name: 'CRM', Id: 'appCRM01' } });
    const listed = async () => (await adapter.getRelated({ position: base, fieldId: 'Tables', direction: 'outgoing' })).map((r) => positionData(r.position));
    expect(await listed()).toMatchObject([{ Name: 'Deals' }, { Name: 'Tasks' }]);
    tables[1] = { ...tasksTable(), name: 'Expenses' };
    expect(await listed()).toMatchObject([{ Name: 'Deals' }, { Name: 'Expenses' }]);
    expect(listedTableBaseIds).toEqual(['appCRM01', 'appCRM01']);
  });
});

describe('waits and subscriptions', () => {
  const crm = () => ({ id: 'appCRM01', name: 'CRM', tables: [dealsTable()] });
  const ops = () => ({ id: 'appOPS01', name: 'Ops', tables: [tasksTable()] });

  it('a wait on a table\'s Changes is keyed by the table, on a base\'s Tables by the base; no other edge is waited on', async () => {
    const { adapter } = makeMultiBaseAdapter({ teamId: 'team-air-keys', bases: [crm()] });
    expect(await adapter.arrivals.awaitKeys({ edge: 'Changes', heads: [{ recordId: 'tblDEALS01', recordType: 'Table' }] })).toEqual([{ key: 'tblDEALS01' }]);
    expect(await adapter.arrivals.awaitKeys({ edge: 'Tables', heads: [{ recordId: 'appCRM01', recordType: 'Base' }] })).toEqual([{ key: 'appCRM01' }]);
    await expect(adapter.arrivals.awaitKeys({ edge: 'Deals', heads: [] })).rejects.toThrow("'Deals' is not a listenable edge");
  });

  it('Changes is one webhook on a base\'s rows, every table of it; Tables one on its schema; at a positioned connection, its own base', async () => {
    const { adapter, webhooks } = makeMultiBaseAdapter({ teamId: 'team-air-subs', bases: [crm(), ops()] });
    await adapter.ensureEventSubscription({ edge: 'Changes', scope: 'appOPS01', callbackUrl: 'https://lf.test/a' });
    await adapter.ensureEventSubscription({ edge: 'Tables', scope: 'appCRM01', callbackUrl: 'https://lf.test/b' });
    expect(webhooks).toEqual([
      { baseId: 'appOPS01', notificationUrl: 'https://lf.test/a', dataTypes: ['tableData'], changeTypes: ['add', 'update', 'remove'] },
      { baseId: 'appCRM01', notificationUrl: 'https://lf.test/b', dataTypes: ['tableMetadata'], changeTypes: ['add', 'update', 'remove'] },
    ]);
    await expect(adapter.ensureEventSubscription({ edge: 'Changes', callbackUrl: 'https://lf.test/c' })).rejects.toThrow("a subscription to 'Changes' names the base it is for");

    const positioned = makeMultiBaseAdapter({ teamId: 'team-air-subs-positioned', bases: [crm(), ops()], base: 'CRM' });
    await positioned.adapter.ensureEventSubscription({ edge: 'Changes', callbackUrl: 'https://lf.test/d' });
    expect(positioned.webhooks).toEqual([{ baseId: 'appCRM01', notificationUrl: 'https://lf.test/d', dataTypes: ['tableData'], changeTypes: ['add', 'update', 'remove'] }]);
  });

  it('a registration with no webhook held first removes any left at its door (a lapsed one Airtable keeps 7 days), and no other', async () => {
    const held = [
      { id: 'achLAPSED', notificationUrl: 'https://lf.test/a' },
      { id: 'achOTHER', notificationUrl: 'https://lf.test/b' },
    ];
    const fresh = makeMultiBaseAdapter({ teamId: 'team-air-lapsed', bases: [crm()], heldWebhooks: held });
    await fresh.adapter.ensureEventSubscription({ edge: 'Changes', scope: 'appCRM01', callbackUrl: 'https://lf.test/a' });
    expect(fresh.deletedWebhooks).toEqual(['achLAPSED']);
    expect(fresh.webhooks).toHaveLength(1);

    // One held is the host's: kept as it is, nothing else touched.
    const kept = makeMultiBaseAdapter({ teamId: 'team-air-lapsed-kept', bases: [crm()], heldWebhooks: held });
    await kept.adapter.ensureEventSubscription({ edge: 'Tables', scope: 'appCRM01', callbackUrl: 'https://lf.test/a', current: { externalId: 'achLAPSED' } });
    expect([kept.deletedWebhooks, kept.webhooks]).toEqual([[], []]);
  });

  it('Changes is scoped by the Bases walked to, or delivered to a connection positioned at its base', async () => {
    const walked = makeMultiBaseAdapter({ teamId: 'team-air-scoped', bases: [crm()] }).adapter;
    const changes = (descriptor: Awaited<ReturnType<AirtableAdapter['describe']>>) => descriptor?.references.find((r) => r.name === 'Changes');
    expect(changes(await walked.describe('Table'))).toMatchObject({ delivery: 'scope', scopedBy: 'Bases' });
    const positioned = makeMultiBaseAdapter({ teamId: 'team-air-scoped-positioned', bases: [crm()], base: 'CRM' }).adapter;
    const declared = changes(await positioned.describe('Table'));
    expect(declared).toMatchObject({ delivery: 'connection' });
    expect(declared?.scopedBy).toBeUndefined();
  });
});

// The write promise has to survive all the way to the CHECKER, not just sit in
// a descriptor: creating a row is THE Airtable operation, and unpositioned the
// per-table edge off a narrowed base is the ONLY place it can be authored (the
// root publishes just the read-only `Base`). Since layer 13 an edge's
// `writable` is EXPLICIT — absent means read-only — so a missing flag here
// failed every row create at the checker while `createRecord` sat implemented.
describe('the table write promise reaches the CHECKER projection', () => {
  const crm = () => ({ id: 'appCRM01', name: 'CRM', tables: [dealsTable()] });
  const ops = () => ({ id: 'appOPS01', name: 'Ops', tables: [tasksTable()] });

  /** The unpositioned instance's schema exactly as the catalog assembles it:
   *  the published entries, each described, through the real projection. */
  async function projectUnpositioned(adapter: AirtableAdapter) {
    const entries = await adapter.listEntryPoints();
    const described = await Promise.all(
      entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
    );
    const projection = instanceSchemaFromDescriptors({
      adapterType: 'airtable',
      entries,
      descriptors: new Map(described.flatMap(([id, d]) => (d ? [[id, d] as const] : []))),
      supportsInPlaceUpdate: false,
    });
    return { entries, projection };
  }

  const source = `import { airtable } from adapters
import { airtable_cred } from credentials
air = airtable(credentials: airtable_cred)
movement m(x: <air-[:\`Record Change\`]->>) {
  air-[b:Base WHERE \`Name\` == "CRM"]-> {
    write b-[:\`Deals\`]-> { Name: "X" }
  }
}`;

  it('the root\'s own edges carry NO write promise — no base or event is created', async () => {
    const { adapter } = makeMultiBaseAdapter({
      teamId: 'team-air-checker-readonly',
      bases: [crm(), ops()],
    });
    const { projection } = await projectUnpositioned(adapter);
    // `createRecord` resolves a TABLE name and calls `recordCreateRecord`;
    // there is no create-base and no create-table call anywhere in the client,
    // so neither root edge may promise one.
    expect(projection.schema.writableRoots.Base).toBeUndefined();
    expect(projection.schema.writableRoots['Record Change']).toBeUndefined();
  });

  it('a base-POSITIONED root publishes its tables as writable roots', async () => {
    const { adapter } = makeMultiBaseAdapter({
      teamId: 'team-air-checker-positioned',
      bases: [crm(), ops()],
      base: 'CRM',
    });
    const { projection } = await projectUnpositioned(adapter);
    // Positioned, the table IS a root — the same write, reached without the
    // base hop. Both standpoints must promise it, because both dispatch into
    // the same `createRecord`.
    expect(projection.schema.writableRoots.Deals?.fields).toMatchObject({ Name: 'text' });
  });

  it('select choices reach the projection as enums, one value or many; an empty select stays text', async () => {
    const { adapter } = makeMultiBaseAdapter({
      teamId: 'team-air-checker-enums',
      bases: [crm(), ops()],
      base: 'CRM',
    });
    const { projection } = await projectUnpositioned(adapter);
    const deals = projection.schema.positions.Deals?.properties;
    expect(deals?.Stage).toMatchObject({ kind: 'enum', options: ['Open', 'Won'] });
    expect(deals?.Tags).toMatchObject({ kind: 'list', of: { kind: 'enum', options: ['Hot', 'Warm'] } });
    expect(deals?.Region).toBe('text');
  });
});
