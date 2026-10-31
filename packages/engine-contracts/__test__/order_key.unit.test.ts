// An ordering key is written as an expression, or as a legacy field reference
// saved before that. Whichever member a key is, it must read back whole: a
// union that matched the wrong member would drop the keys only the other one
// carries (`old` on a field reference, `fieldOnly` on an expression).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { expressionSchema } from '../expression/expression';
import { traversalStepSchema } from '../expression/schemas';

const { samples } = z.object({ samples: z.record(z.string(), z.unknown()) }).parse(JSON.parse(readFileSync(join(__dirname, '../conformance/expression-samples.json'), 'utf8')));

const keys = {
  'a legacy edge_property field reference with old': { type: 'edge_property', propertyTypeId: 'k', old: true },
  'a legacy node_property field reference with old': { type: 'node_property', propertyTypeId: 'k', old: true },
  'a legacy linked_object field reference with actionNodeId': { type: 'linked_object', adapter: 'A', actionNodeId: 'n1', field: 'f' },
  'an expression edge_property with fieldOnly': { type: 'edge_property', propertyTypeId: 'k', fieldOnly: true },
  'an expression property with fieldOnly': { type: 'property', propertyTypeId: 'k', fieldOnly: true },
  'an expression linked_object without actionNodeId': { type: 'linked_object', adapter: 'A', field: 'f' },
  ...Object.fromEntries(Object.entries(samples).map(([name, sample]) => [`the ${name} expression sample`, sample])),
};

describe.each(Object.entries(keys))('%s as an ordering key', (_name, key) => {
  it('reads whole as an aggregate orderBy', () => {
    const aggregate = { type: 'aggregate', fn: 'sort', expression: { type: 'property', propertyTypeId: 'x' }, orderBy: key };
    expect(expressionSchema.parse(aggregate)).toEqual(aggregate);
  });

  it('reads whole as a hop cardinality orderBy', () => {
    const step = { type: 'edge', edgeTypeId: 'E', direction: 'outgoing', cardinality: { mode: 'first', orderBy: key } };
    expect(traversalStepSchema.parse(step)).toEqual(step);
  });
});
