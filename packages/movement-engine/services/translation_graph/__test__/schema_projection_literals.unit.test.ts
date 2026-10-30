// A reference that types fields of its landing by the literals a write wrote
// (`literalsFrom`) projects them onto its edge verbatim, as `genericOver` is:
// the checker reads both ends from the edge and knows no field by name.

import type { SchemaEntryPoint, SchemaTypeDescriptor } from 'engine-contracts/catalog';
import { instanceSchemaFromDescriptors } from '../movement/schema_projection';

const entries: SchemaEntryPoint[] = [{ typeId: 'poll', displayName: 'Poll', writable: true, readable: true }];

const poll: SchemaTypeDescriptor = {
  typeId: 'poll',
  displayName: 'Poll',
  fields: [{ fieldId: 'q', displayName: 'Question', kind: 'string', writable: true, required: false }],
  references: [
    {
      fieldId: 'votes',
      name: 'Votes',
      targetTypeId: 'vote',
      cardinality: 'many',
      direction: 'outgoing',
      readable: false,
      listenable: true,
      literalsFrom: [{ at: ['Choice'], from: 'Options[].Key' }],
    },
  ],
};

describe('a reference typed by the literals a write wrote', () => {
  it('projects literalsFrom onto its edge', () => {
    const projected = instanceSchemaFromDescriptors({
      adapterType: 'polls',
      entries,
      descriptors: new Map([['poll', poll]]),
      supportsInPlaceUpdate: false,
    });
    expect(projected.schema.positions['Poll'].edges['Votes']).toEqual({
      target: 'vote',
      readable: false,
      listenable: true,
      literalsFrom: [{ at: ['Choice'], from: 'Options[].Key' }],
    });
  });
});
