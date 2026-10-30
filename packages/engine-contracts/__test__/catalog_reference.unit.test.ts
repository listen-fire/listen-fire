// A reference's edge capabilities: what 0.13 declares, and the two keys it
// retired, refused rather than stripped.
import { schemaReferenceDescriptorSchema } from '../catalog';

const reference = { fieldId: 'r', name: 'Replies', targetTypeId: 'm', cardinality: 'many', direction: 'outgoing' } as const;

describe('a reference descriptor', () => {
  it('refuses awaitable and watchable on a reference, naming listenable', () => {
    for (const key of ['awaitable', 'watchable']) {
      const r = schemaReferenceDescriptorSchema.safeParse({ ...reference, [key]: true });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain(
        `'Replies' declares '${key}', retired in 0.13: declare 'listenable: true' (and 'identity', the landing's field that names it)`,
      );
    }
  });

  it('carries listenable, cursor, identity and version', () => {
    const declared = { ...reference, listenable: true, cursor: false, identity: 'Timestamp', version: 'Edited', sequenced: 'chronological' };
    expect(schemaReferenceDescriptorSchema.parse(declared)).toEqual(declared);
  });
});
