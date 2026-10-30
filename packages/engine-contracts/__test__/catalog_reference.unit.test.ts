// A reference's edge capabilities: what 0.13 declares, and the two keys it
// retired, refused rather than stripped.
import {
  parseWritePath,
  schemaReferenceDescriptorSchema,
  schemaTypeDescriptorSchema,
  undeclaredArrivalField,
  unreadableLiteralsFrom,
} from '../catalog';
import cases from './write_paths.cases.json';

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

  it('carries literalsFrom: fields of the landing typed by the literals a write wrote at a path', () => {
    const declared = { ...reference, listenable: true, literalsFrom: [{ at: ['Actions', 'Value'], from: 'Buttons[].Value' }] };
    expect(schemaReferenceDescriptorSchema.parse(declared)).toEqual(declared);
    expect(schemaReferenceDescriptorSchema.safeParse({ ...reference, literalsFrom: [{ at: [], from: 'Options[].Key' }] }).success).toBe(false);
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

describe('a literalsFrom path', () => {
  // Shared with the checker's reader of the same grammar (movement-checker
  // tests/write_literals.rs), so the two cannot drift.
  it.each(cases.read)('reads $path', ({ path, steps }) => {
    expect(parseWritePath(path)).toEqual({ steps: steps.map(([field, each]) => ({ field, each })) });
  });

  it.each(cases.refused)('refuses $path', ({ path, message }) => {
    expect(parseWritePath(path)).toEqual({ refused: message });
  });
});

describe("a reference's literalsFrom", () => {
  const descriptors = new Map(
    [
      {
        typeId: 'i',
        displayName: 'Interaction',
        fields: [{ fieldId: 'id', displayName: 'Id', kind: 'string', writable: false, required: false }],
        references: [
          { fieldId: 'actions', name: 'Actions', targetTypeId: 'a', cardinality: 'many', direction: 'outgoing' },
          { fieldId: 'on', name: 'On', targetTypeId: 'a', targetTypeIds: ['a', 'i'], cardinality: 'one', direction: 'outgoing' },
        ],
      },
      {
        typeId: 'a',
        displayName: 'Action',
        fields: [
          { fieldId: 'v', displayName: 'Value', kind: 'string', writable: false, required: false },
          { fieldId: 'n', displayName: 'Count', kind: 'number', writable: false, required: false },
          { fieldId: 't', displayName: 'Tags', kind: 'string', cardinality: 'many', writable: false, required: false },
        ],
        references: [],
      },
    ].map((d) => [d.typeId, schemaTypeDescriptorSchema.parse(d)] as const),
  );
  const interactions = (at: string[], from: string) =>
    schemaReferenceDescriptorSchema.parse({ ...reference, name: 'Interactions', targetTypeId: 'i', listenable: true, literalsFrom: [{ at, from }] });
  const refusal = (at: string[], from = 'Buttons[].Value') => unreadableLiteralsFrom(interactions(at, from), descriptors);

  it('types one text field of its landing', () => {
    expect(refusal(['Actions', 'Value'])).toBeUndefined();
    expect(refusal(['Id'])).toBeUndefined();
  });

  it('is refused, in listen-fire\'s words, when it cannot type what it says', () => {
    expect(refusal(['Actions', 'Value'], 'Buttons[.Value')).toBe(
      "'Interactions' declares a literalsFrom path that cannot be read: 'Buttons[.Value' has a stray bracket in 'Buttons[': only '[]' may follow a field, before the next '.'",
    );
    expect(refusal(['Actions', 'Valu'])).toBe(
      "'Interactions' declares literalsFrom at 'Actions.Valu', a field its landing 'Action' does not declare (it declares: Value, Count, Tags)",
    );
    expect(refusal(['Action', 'Value'])).toBe(
      "'Interactions' declares literalsFrom at 'Action.Value', but its landing 'Interaction' has no reference 'Action' (it has: Actions, On)",
    );
    expect(refusal(['On', 'Value'])).toBe(
      "'Interactions' declares literalsFrom, but 'On' lands on more than one type (Action, Interaction): a field typed by a write's literals needs one landing",
    );
    for (const field of ['Count', 'Tags']) {
      expect(refusal(['Actions', field])).toBe(
        `'Interactions' declares literalsFrom at 'Actions.${field}', but '${field}' on 'Action' is not a single text field: a write's text literals type only text`,
      );
    }
    const answers = schemaReferenceDescriptorSchema.parse({
      ...reference,
      name: 'Answers',
      targetTypeId: 'a',
      targetTypeIds: ['a', 'i'],
      literalsFrom: [{ at: ['Value'], from: 'Options[].Key' }],
    });
    expect(unreadableLiteralsFrom(answers, descriptors)).toBe(
      "'Answers' declares literalsFrom, but 'Answers' lands on more than one type (Action, Interaction): a field typed by a write's literals needs one landing",
    );
  });

  it('leaves a landing nobody described unjudged', () => {
    expect(unreadableLiteralsFrom(interactions(['Anything'], 'Buttons[].Value'), new Map())).toBeUndefined();
  });
});
