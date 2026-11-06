// A type with no position (known only by what is written to it) has its
// module's description on the root edge that reaches it. A type with a position
// keeps it there, so one fact lives in one place. The field descriptions of such
// a type are on its write shape already.

import type { SchemaEntryPoint, SchemaTypeDescriptor } from 'engine-contracts/catalog';
import { instanceSchemaFromDescriptors } from '../movement/schema_projection';

const descriptor = (typeId: string): SchemaTypeDescriptor => ({
  typeId,
  displayName: typeId,
  description: `What a ${typeId} is.`,
  fields: [{ fieldId: 'Title', displayName: 'Title', kind: 'string', writable: true, required: true, description: 'Its title.' }],
  references: [],
});

const entries: SchemaEntryPoint[] = [
  { typeId: 'Form', displayName: 'Form', writable: true, readable: false, collectionName: 'Forms' },
  { typeId: 'Deals', displayName: 'Deals', writable: true, readable: true },
];

describe('a root edge', () => {
  const { schema } = instanceSchemaFromDescriptors({
    adapterType: 'forms',
    entries,
    descriptors: new Map(['Form', 'Deals'].map((id) => [id, descriptor(id)])),
    supportsInPlaceUpdate: false,
  });

  it('says what a type with no position is', () => {
    expect(schema.collections['Forms']?.description).toBe('What a Form is.');
    expect(schema.writableRoots['Form']?.fieldDocs).toEqual({ Title: 'Its title.' });
  });

  it('leaves a type with a position to say it there', () => {
    expect(schema.collections['Deals']?.description).toBeUndefined();
    expect(schema.positions['Deals']?.description).toBe('What a Deals is.');
  });
});
