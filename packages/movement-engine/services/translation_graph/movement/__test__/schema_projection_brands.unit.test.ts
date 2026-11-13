// A module's field may declare brands. The same descriptor projects to the
// same type here and in the Rust projection (`crates/lf/src/schema.rs`, whose
// test of the same name holds the same JSON).

import { schemaFieldDescriptorSchema } from 'engine-contracts';

import { fieldTypeFromDescriptor } from '../schema_projection';

const at = { owner: 'slack', positionOf: (typeId: string) => typeId };
const field = (more: Record<string, unknown>) =>
  schemaFieldDescriptorSchema.parse({ fieldId: 'f', displayName: 'F', writable: false, required: false, ...more });

describe('a branded descriptor', () => {
  it('a_branded_descriptor_projects_to_a_branded_type', () => {
    const projected = fieldTypeFromDescriptor(field({ kind: 'string', brands: ['claim:email/address'], mayBeAbsent: true }), at);
    expect(JSON.stringify(projected)).toBe('{"kind":"maybeAbsent","of":{"kind":"branded","of":"text","brands":["claim:email/address"]}}');
    expect(JSON.stringify(fieldTypeFromDescriptor(field({ kind: 'number', brands: ['claim:github/user_id'] }), at))).toBe(
      '{"kind":"branded","of":"number","brands":["claim:github/user_id"]}',
    );
    expect(JSON.stringify(fieldTypeFromDescriptor(field({ kind: 'string', cardinality: 'many', brands: ['claim:email/address'] }), at))).toBe(
      '{"kind":"list","of":{"kind":"branded","of":"text","brands":["claim:email/address"]}}',
    );
  });

  it('is refused on a kind that is not a scalar, and when it names nothing', () => {
    for (const kind of ['boolean', 'json', 'date', 'enum', 'file', 'owned', 'record', 'reference']) {
      const refused = schemaFieldDescriptorSchema.safeParse({ fieldId: 'f', displayName: 'F', writable: false, required: false, kind, brands: ['claim:x/y'] });
      expect(refused.success).toBe(false);
      expect(JSON.stringify(refused.error?.issues)).toContain("'brands' narrow a string or a number");
    }
    expect(schemaFieldDescriptorSchema.safeParse({ fieldId: 'f', displayName: 'F', writable: false, required: false, kind: 'string', brands: [] }).success).toBe(false);
  });

  it('a field without brands projects as it did', () => {
    expect(fieldTypeFromDescriptor(field({ kind: 'string' }), at)).toBe('text');
  });
});
