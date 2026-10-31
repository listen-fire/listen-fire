// What `introspectAdapter` refuses of an adapter's answers, in the words
// listen-fire's describe uses: it zod-parses nothing the adapter says, so these
// refusals are the only ones an embedder's catalog build meets.

import type { SchemaEntryPoint, SchemaFieldDescriptor } from 'engine-contracts/catalog';

import type { Adapter } from '../../translation_graph/adapter';
import { introspectAdapter } from '../introspect';

const MANIFEST = { adapterType: 'cron', methods: [] };

function cron(entry: object, fields: object[]): Adapter {
  // The answers arrive as JSON from a module: declared as written, not as the schema would have let them be.
  const entries: SchemaEntryPoint[] = JSON.parse(JSON.stringify([{ typeId: 'tick', displayName: 'Tick', collectionName: 'Ticks', writable: false, readable: false, listenable: true, ...entry }]));
  const described: SchemaFieldDescriptor[] = JSON.parse(JSON.stringify(fields));
  return {
    adapterType: 'cron',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => entries,
    describe: async (typeId) => (typeId === 'tick' ? { typeId: 'tick', displayName: 'Tick', fields: described, references: [] } : null),
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async () => null,
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'cron', externalId: 'r1', recordType: 'Tick', data: {} }),
    updateRecord: async () => {
      throw new Error('not used');
    },
    deleteRecord: async () => ({}),
  };
}

const UNNAMED = { fieldId: 'schedule', displayName: 'Schedule', kind: 'owned', writable: false, required: false };
const SCHEDULE = { ...UNNAMED, owned: { name: 'Cron' } };

describe('introspectAdapter', () => {
  it('reads an owned scalar the adapter names', async () => {
    const { schema } = await introspectAdapter(cron({}, [SCHEDULE]), MANIFEST);
    expect(schema.positions.Tick?.properties.Schedule).toEqual({ kind: 'owned', name: 'Cron', owner: 'cron' });
  });

  it('refuses an owned field that names no scalar, naming the field', async () => {
    await expect(introspectAdapter(cron({}, [UNNAMED]), MANIFEST)).rejects.toThrow(
      "cron describes 'tick': 'Schedule' is of kind 'owned' but declares no 'owned.name': name the scalar its adapter parses",
    );
  });

  it('refuses a listening declaration that cannot mean what it says, naming the entry point', async () => {
    await expect(introspectAdapter(cron({ delivery: 'pushed' }, [SCHEDULE]), MANIFEST)).rejects.toThrow(
      `cron lists 'tick': 'Ticks' declares delivery "pushed", which is none of 'connection', 'scope' or 'polled'`,
    );
  });
});
