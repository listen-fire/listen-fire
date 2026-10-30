// A reference's edge capabilities: what 0.13 declares, and the two keys it
// retired, refused rather than stripped.
import { schemaReferenceDescriptorSchema, schemaTypeDescriptorSchema, undeclaredArrivalField } from '../catalog';

const reference = { fieldId: 'r', name: 'Replies', targetTypeId: 'm', cardinality: 'many', direction: 'outgoing' } as const;

describe('a reference descriptor', () => {
  it('refuses awaitable and watchable on a reference, naming listenable', () => {
    for (const key of ['awaitable', 'watchable']) {
      const r = schemaReferenceDescriptorSchema.safeParse({ ...reference, [key]: true });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain(
        `'Replies' declares '${key}', retired in 0.13: declare 'listenable: true' (and, optionally, 'identity': the landing's field that names an arrival)`,
      );
    }
  });

  it('carries listenable, cursor, identity and version', () => {
    const declared = { ...reference, listenable: true, cursor: false, identity: 'Timestamp', version: 'Edited', sequenced: 'chronological' };
    expect(schemaReferenceDescriptorSchema.parse(declared)).toEqual(declared);
  });
});

describe("a reference's identity and version", () => {
  const message = schemaTypeDescriptorSchema.parse({
    typeId: 'm',
    displayName: 'Message',
    fields: [{ fieldId: 'ts', displayName: 'Timestamp', kind: 'date', writable: false, required: false }],
    references: [],
  });
  const descriptors = new Map([['m', message]]);
  const replies = (extra: Record<string, string>) =>
    schemaReferenceDescriptorSchema.parse({ ...reference, listenable: true, ...extra });

  it('names a field the landing declares', () => {
    expect(undeclaredArrivalField(replies({ identity: 'Timestamp' }), descriptors)).toBeUndefined();
  });

  it('is refused when it names a field the landing does not declare', () => {
    expect(undeclaredArrivalField(replies({ identity: 'ts' }), descriptors)).toBe(
      "'Replies' names 'ts' as its identity, a field its landing 'Message' does not declare (it declares: Timestamp)",
    );
    expect(undeclaredArrivalField(replies({ identity: 'Timestamp', version: 'Edited' }), descriptors)).toBe(
      "'Replies' names 'Edited' as its version, a field its landing 'Message' does not declare (it declares: Timestamp)",
    );
  });

  it('leaves a landing nobody described unjudged', () => {
    expect(undeclaredArrivalField(replies({ identity: 'Anything' }), new Map())).toBeUndefined();
  });
});
