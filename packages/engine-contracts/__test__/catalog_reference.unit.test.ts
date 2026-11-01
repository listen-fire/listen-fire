// A reference's edge capabilities: what 0.13 declares, and the three keys it
// retired, refused rather than stripped.
import {
  RETIRED_ENTRY_KEYS,
  RETIRED_MANIFEST_KEYS,
  retiredEntryKey,
  ambiguousArrivals,
  parseWritePath,
  schemaEntryPointSchema,
  schemaFieldDescriptorSchema,
  schemaReferenceDescriptorSchema,
  schemaTypeDescriptorSchema,
  undeclaredArrivalField,
  unreadableAnswerShapeFrom,
  unreadableListening,
  unreadableLiteralsFrom,
  unreadableOwnedField,
  unreadableRecordField,
  unreadableSettingsBecome,
  type SchemaEntryPoint,
} from '../catalog';
import type { SettingsBecome } from 'movement-lang';
import { WireListenDeclarations } from '../protocol';
import cases from './write_paths.cases.json';
import settingsBecome from './settings_become.cases.json';
import scopedBy from './scoped_by.cases.json';
import retiredEntryKeys from './retired_entry_key.cases.json';

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

  it('refuses resolvesEmpty on a reference: a deleted record leaves the wait waiting on every edge', () => {
    const r = schemaReferenceDescriptorSchema.safeParse({ ...reference, listenable: true, resolvesEmpty: true });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(
      "'Replies' declares 'resolvesEmpty', retired in 0.13: a deleted record leaves the wait waiting on every edge, so there is nothing to declare: drop it",
    );
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

describe("a reference's answerShapeFrom", () => {
  const form = schemaTypeDescriptorSchema.parse({
    typeId: 'f',
    displayName: 'Form',
    fields: [
      { fieldId: 'title', displayName: 'Title', kind: 'string', writable: true, required: true },
      { fieldId: 'fields', displayName: 'Fields', kind: 'json', writable: true, required: true },
      { fieldId: 'url', displayName: 'Url', kind: 'string', writable: false, required: false },
      { fieldId: 'seen', displayName: 'Seen', kind: 'json', writable: false, required: false },
    ],
    references: [],
  });
  const descriptors = new Map([
    ['f', form],
    ['s', schemaTypeDescriptorSchema.parse({ typeId: 's', displayName: 'Submission', fields: [], references: [] })],
  ]);
  const submissions = (answerShapeFrom: string, more: object = {}) =>
    schemaReferenceDescriptorSchema.parse({ ...reference, name: 'Submissions', targetTypeId: 's', listenable: true, answerShapeFrom, ...more });

  it('is carried by the reference schema', () => {
    expect(submissions('Fields').answerShapeFrom).toBe('Fields');
    expect(schemaReferenceDescriptorSchema.safeParse({ ...reference, answerShapeFrom: '' }).success).toBe(false);
  });

  it('names one writable json field of the type it hangs off', () => {
    expect(unreadableAnswerShapeFrom(submissions('Fields'), form, descriptors)).toBeUndefined();
  });

  it("is refused, in listen-fire's words, when it cannot type what it says", () => {
    expect(unreadableAnswerShapeFrom(submissions('Questions'), form, descriptors)).toBe(
      "'Submissions' takes its answer's shape from 'Questions', a field 'Form' does not declare (it declares: Title, Fields, Url, Seen)",
    );
    for (const field of ['Title', 'Seen']) {
      expect(unreadableAnswerShapeFrom(submissions(field), form, descriptors)).toBe(
        `'Submissions' takes its answer's shape from '${field}', but '${field}' on 'Form' is not a single writable json field: the write names a node there, and the module receives its fields as json`,
      );
    }
    expect(unreadableAnswerShapeFrom(submissions('Fields', { targetTypeIds: ['s', 'f'] }), form, descriptors)).toBe(
      "'Submissions' takes its answer's shape from 'Fields', but it lands on more than one type (Submission, Form): a shape gives one landing its fields",
    );
  });
});

// What an edge or a root collection declares about being listened to, refused
// in listen-fire's words (crates/lf schema.rs `unreadable_listening`).
describe('a listening declaration', () => {
  const tick = schemaTypeDescriptorSchema.parse({
    typeId: 'tick',
    displayName: 'Tick',
    fields: [{ fieldId: 'schedule', displayName: 'Schedule', kind: 'string', writable: false, required: true }],
    references: [],
  });
  const ticks = (declares: object) => {
    const entry = schemaEntryPointSchema.parse({ typeId: 'tick', displayName: 'Tick', collectionName: 'Ticks', writable: false, readable: false, listenable: true, ...declares });
    return unreadableListening({ entry }, [entry], new Map([['tick', tick]]));
  };

  // introspectAdapter does not zod-parse what an adapter answers, so a
  // declaration the schema would have refused reaches `unreadableListening`
  // as written.
  const declaredAsWritten = (declares: object): SchemaEntryPoint =>
    JSON.parse(JSON.stringify({ typeId: 'tick', displayName: 'Tick', collectionName: 'Ticks', writable: false, readable: false, listenable: true, ...declares }));
  const ticksAsWritten = (declares: object) => {
    const entry = declaredAsWritten(declares);
    return unreadableListening({ entry }, [entry], new Map([['tick', tick]]));
  };

  it('refuses an unbounded edge with nothing to narrow it by', () => {
    expect(ticks({ bounded: false })).toBe("'Ticks' declares 'bounded: false' but no 'boundedBy': name the fields a listen narrows it by");
    expect(ticks({ bounded: false, boundedBy: [] })).toBe("'Ticks' declares 'bounded: false' but no 'boundedBy': name the fields a listen narrows it by");
    expect(ticks({ bounded: false, boundedBy: ['Schedule'] })).toBeUndefined();
    expect(ticks({ boundedBy: ['Schedule'] })).toBe("'Ticks' declares 'boundedBy' but not 'bounded: false': only an unbounded edge is narrowed by it");
  });

  it('refuses a boundedBy or root identity naming a field the landing does not declare', () => {
    expect(ticks({ bounded: false, boundedBy: ['Cron'] })).toBe(
      "'Ticks' names 'Cron' in its boundedBy, a field its landing 'Tick' does not declare (it declares: Schedule)",
    );
    expect(ticks({ identity: 'Id' })).toBe("'Ticks' names 'Id' as its identity, a field its landing 'Tick' does not declare (it declares: Schedule)");
  });

  it('refuses a polled edge that does not state its interval', () => {
    expect(ticks({ delivery: 'polled' })).toBe("'Ticks' declares 'delivery: polled' but no 'pollEverySeconds': state how often the module polls it");
    expect(ticks({ delivery: 'polled', pollEverySeconds: 60 })).toBeUndefined();
    expect(ticks({ delivery: 'polled', pollEverySeconds: 0 })).toBe("'Ticks' declares 'pollEverySeconds: 0': expected a positive whole number of seconds");
    expect(ticks({ delivery: 'connection', pollEverySeconds: 60 })).toBe(
      "'Ticks' declares 'pollEverySeconds' but not 'delivery: polled': only a polled edge is polled",
    );
    expect(schemaEntryPointSchema.safeParse({ typeId: 't', displayName: 'T', writable: false, readable: false, delivery: 'pushed' }).success).toBe(false);
  });

  it('refuses a root collection that delivers by scope: nothing comes before it', () => {
    expect(ticks({ delivery: 'scope' })).toBe(
      "'Ticks' declares 'delivery: scope', and 'Ticks' is a root collection: nothing comes before it to scope a subscription by",
    );
    expect(ticks({ delivery: 'connection' })).toBeUndefined();
  });

  it('refuses a hop whose changes are pushed that announces nothing', () => {
    expect(ticks({ listenable: false, cheapToList: true, parentChanges: 'pushed' })).toBe(
      "'Ticks' declares 'parentChanges: pushed' but not 'listenable: true': the module reports its members' changes as arrivals on 'Ticks' itself, so it must announce them",
    );
    expect(ticks({ listenable: false, cheapToList: true, relistEverySeconds: 300 })).toBeUndefined();
    expect(ticks({ cheapToList: true, parentChanges: 'pushed' })).toBeUndefined();
  });

  it('refuses a hop cheap to list that says nothing of how its members change', () => {
    expect(ticks({ cheapToList: true })).toBe(
      "'Ticks' declares 'cheapToList: true' but neither 'parentChanges: pushed' nor 'relistEverySeconds': say how a listen learns its members changed",
    );
    expect(ticks({ cheapToList: true, relistEverySeconds: 300 })).toBeUndefined();
    expect(ticks({ cheapToList: true, parentChanges: 'pushed' })).toBeUndefined();
    expect(ticks({ cheapToList: true, parentChanges: 'pushed', relistEverySeconds: 300 })).toBe(
      "'Ticks' declares both 'parentChanges: pushed' and 'relistEverySeconds': a module that reports its members' changes is not re-listed on a clock; declare one",
    );
    expect(ticks({ relistEverySeconds: 300 })).toBe("'Ticks' declares 'relistEverySeconds' but not 'cheapToList: true': only a hop cheap to list is re-listed");
  });

  it('refuses a delivery that is none of the three, and a parentChanges that is not pushed', () => {
    expect(ticksAsWritten({ delivery: 'pushed' })).toBe(`'Ticks' declares delivery "pushed", which is none of 'connection', 'scope' or 'polled'`);
    expect(ticksAsWritten({ cheapToList: true, parentChanges: 'polled' })).toBe(`'Ticks' declares parentChanges "polled": the one value is 'pushed'`);
  });

  it('refuses parentChanges on a hop that is not cheap to list', () => {
    expect(ticks({ parentChanges: 'pushed' })).toBe("'Ticks' declares 'parentChanges' but not 'cheapToList: true': only a hop cheap to list is re-listed");
  });

  it('refuses a number of seconds that is not a positive whole number', () => {
    for (const [declared, shown] of [
      [0, '0'],
      [-5, '-5'],
      [1.5, '1.5'],
      ['300', '"300"'],
    ] as const) {
      expect(ticksAsWritten({ cheapToList: true, relistEverySeconds: declared })).toBe(
        `'Ticks' declares 'relistEverySeconds: ${shown}': expected a positive whole number of seconds`,
      );
    }
  });

  it('refuses a root collection that declares what it carries: nothing comes before it', () => {
    expect(ticks({ carries: ['Bases'] })).toBe(
      "'Ticks' says its arrivals carry earlier hops, but 'carries' names 'Bases', and 'Ticks' is a root collection: nothing comes before it",
    );
  });

  describe('carries', () => {
    const entries = [schemaEntryPointSchema.parse({ typeId: 'm', displayName: 'Message', collectionName: 'Messages', writable: false, readable: true })];
    const message = schemaTypeDescriptorSchema.parse({
      typeId: 'm',
      displayName: 'Message',
      fields: [],
      references: [{ ...reference, fieldId: 'i', name: 'Interactions', targetTypeId: 'i' }],
    });
    const interaction = schemaTypeDescriptorSchema.parse({ typeId: 'i', displayName: 'Interaction', fields: [], references: [] });
    const descriptors = new Map([
      ['m', message],
      ['i', interaction],
    ]);
    const interactions = (carries: string[]) =>
      unreadableListening(
        { reference: schemaReferenceDescriptorSchema.parse({ ...reference, fieldId: 'i', name: 'Interactions', targetTypeId: 'i', listenable: true, carries }), owner: 'm' },
        entries,
        descriptors,
      );

    it('names the hops before the edge, outermost first', () => {
      expect(interactions(['Messages'])).toBeUndefined();
    });

    it('carries naming the hops innermost first is refused: the innermost hop is the last', () => {
      const bases = schemaEntryPointSchema.parse({ typeId: 'b', displayName: 'Base', collectionName: 'Bases', writable: false, readable: true });
      const base = schemaTypeDescriptorSchema.parse({
        typeId: 'b',
        displayName: 'Base',
        fields: [],
        references: [{ ...reference, fieldId: 'm', name: 'Messages', targetTypeId: 'm' }],
      });
      const changes = (carries: string[]) =>
        unreadableListening(
          { reference: schemaReferenceDescriptorSchema.parse({ ...reference, fieldId: 'i', name: 'Interactions', targetTypeId: 'i', listenable: true, carries }), owner: 'm' },
          [bases],
          new Map([...descriptors, ['b', base]]),
        );
      expect(changes(['Bases', 'Messages'])).toBeUndefined();
      // A hop not carried may come between: the base, not the message.
      expect(changes(['Bases'])).toBeUndefined();
      expect(changes(['Messages', 'Bases'])).toBe(
        "'Interactions' says its arrivals carry earlier hops, but 'carries' names 'Messages', and 'Bases' is a root collection: nothing comes before it; 'carries' lists hops outermost first, so 'Bases' comes before 'Messages'",
      );
    });

    it('carries naming no earlier hop is refused', () => {
      expect(interactions(['Nope'])).toMatch(/'carries' names 'Nope', which is no edge into 'Message' or a record before it/);
      expect(interactions(['Nope'])).toBe(
        "'Interactions' says its arrivals carry earlier hops, but 'carries' names 'Nope', which is no edge into 'Message' or a record before it (the edges into them: Messages)",
      );
      expect(interactions(['Nope', 'Messages'])).toBe(
        "'Interactions' says its arrivals carry earlier hops, but 'carries' names 'Nope', and 'Messages' is a root collection: nothing comes before it",
      );
    });
  });
});

// The same cases as listen-fire's `ambiguous_arrivals` test, with the same words.
describe('a listenable edge name off several record types', () => {
  const entry = (typeId: string, displayName: string, collectionName: string, more: object = {}) =>
    schemaEntryPointSchema.parse({ typeId, displayName, collectionName, writable: false, readable: true, ...more });
  const entries = [entry('invoice', 'Invoice', 'Invoices'), entry('customer', 'Customer', 'Customers')];
  const described = (typeId: string, displayName: string, references: object[]) =>
    [typeId, schemaTypeDescriptorSchema.parse({ typeId, displayName, fields: [], references })] as const;
  const changes = (targetTypeId: string, listenable: boolean) => ({ fieldId: 'changes', name: 'Changes', targetTypeId, cardinality: 'many', direction: 'outgoing', listenable });
  const module = (invoice: object[], customer: object[]) =>
    new Map([
      described('invoice', 'Invoice', invoice),
      described('customer', 'Customer', customer),
      described('change', 'Change', []),
      described('invoice_change', 'InvoiceChange', []),
      described('customer_change', 'CustomerChange', []),
    ]);

  it('lands on a record type of its own from each', () => {
    expect(ambiguousArrivals(entries, module([changes('invoice_change', true)], [changes('customer_change', true)]))).toBeUndefined();
  });

  it('is refused landing on one record type from two of them', () => {
    expect(ambiguousArrivals(entries, module([changes('change', true)], [changes('change', true)]))).toBe(
      "'Changes' off 'Invoice' and 'Customer', each landing on 'Change': an arrival names its edge and the record type it landed on, so arrivals on these could not be told apart; land each on its own record type",
    );
  });

  it('is not refused beside a root collection of the same name: its arrivals name no key', () => {
    const rooted = [entries[0], entry('change', 'Change', 'Changes', { listenable: true })];
    expect(ambiguousArrivals(rooted, module([changes('change', true)], []))).toBeUndefined();
  });

  it('is not refused where nothing arrives: an edge no listen can take', () => {
    expect(ambiguousArrivals(entries, module([changes('change', true)], [changes('change', false)]))).toBeUndefined();
  });
});

describe('an owned field', () => {
  const owned = { fieldId: 'schedule', displayName: 'Schedule', writable: false, required: true };

  it('names the scalar its module owns', () => {
    expect(schemaFieldDescriptorSchema.parse({ ...owned, kind: 'owned', owned: { name: 'Cron' } }).owned).toEqual({ name: 'Cron' });
  });

  it('is refused without the name, and a name on another kind is refused', () => {
    expect(schemaFieldDescriptorSchema.safeParse({ ...owned, kind: 'owned' }).success).toBe(false);
    expect(schemaFieldDescriptorSchema.safeParse({ ...owned, kind: 'string', owned: { name: 'Cron' } }).success).toBe(false);
  });

  it('is refused by name at describe when it names no scalar, as listen-fire refuses it', () => {
    const asDescribed = (kind: string, extra: object = {}): Parameters<typeof unreadableOwnedField>[0] => JSON.parse(JSON.stringify({ ...owned, kind, ...extra }));
    const expected = "'Schedule' is of kind 'owned' but declares no 'owned.name': name the scalar its adapter parses";
    expect(unreadableOwnedField(asDescribed('owned', { owned: { name: 'Cron' } }))).toBeUndefined();
    expect(unreadableOwnedField(asDescribed('string'))).toBeUndefined();
    expect(unreadableOwnedField(asDescribed('owned'))).toBe(expected);
    expect(unreadableOwnedField(asDescribed('owned', { owned: {} }))).toBe(expected);
    expect(unreadableOwnedField(asDescribed('owned', { owned: { name: '' } }))).toBe(expected);
  });
});

describe('a record field', () => {
  const held = { fieldId: 'cur', displayName: 'Current', writable: false, required: false };

  it('names the type of the record it holds, and may be absent', () => {
    const parsed = schemaFieldDescriptorSchema.parse({ ...held, kind: 'record', record: { typeId: 'Row' }, mayBeAbsent: true });
    expect([parsed.record, parsed.mayBeAbsent]).toEqual([{ typeId: 'Row' }, true]);
  });

  it('is refused without the type, and a type on another kind is refused', () => {
    expect(schemaFieldDescriptorSchema.safeParse({ ...held, kind: 'record' }).success).toBe(false);
    expect(schemaFieldDescriptorSchema.safeParse({ ...held, kind: 'json', record: { typeId: 'Row' } }).success).toBe(false);
  });

  it('is refused by name at describe when it names no type, as listen-fire refuses it', () => {
    const asDescribed = (extra: object = {}): Parameters<typeof unreadableRecordField>[0] => JSON.parse(JSON.stringify({ ...held, kind: 'record', ...extra }));
    const expected = "'Current' is of kind 'record' but declares no 'record.typeId': name the type of the record it holds";
    expect(unreadableRecordField(asDescribed({ record: { typeId: 'Row' } }))).toBeUndefined();
    expect(unreadableRecordField(asDescribed())).toBe(expected);
    expect(unreadableRecordField(asDescribed({ record: { typeId: '' } }))).toBe(expected);
  });
});

// A module's mapping from its 0.12 listen settings to the traversal, judged
// at describe in listen-fire's words (crates/lf schema.rs
// `unreadable_settings_become` reads the same cases).
describe('a listenSettingsBecome', () => {
  const descriptors = new Map(Object.entries(settingsBecome.descriptors).map(([typeId, d]) => [typeId, schemaTypeDescriptorSchema.parse(d)]));
  const entries = (positioned: boolean) => (positioned ? settingsBecome.positioned : settingsBecome.entries).map((e) => schemaEntryPointSchema.parse(e));
  for (const c of settingsBecome.cases) {
    it(c.name, () => {
      const positioned = 'positioned' in c && c.positioned === true;
      expect(unreadableSettingsBecome(c.become as SettingsBecome, entries(positioned), descriptors) ?? null).toBe(c.refusal);
    });
  }
});

// A listenable edge's scopedBy, refused at describe in listen-fire's words
// (crates/lf schema.rs `unreadable_listening` reads the same cases).
describe('a scopedBy', () => {
  const descriptors = new Map(Object.entries(scopedBy.descriptors).map(([typeId, d]) => [typeId, schemaTypeDescriptorSchema.parse(d)]));
  const entries = (positioned: boolean) => (positioned ? scopedBy.positioned : scopedBy.entries).map((e) => schemaEntryPointSchema.parse(e));
  for (const c of scopedBy.cases) {
    it(c.name, () => {
      const positioned = 'positioned' in c && c.positioned === true;
      const declarant =
        'entry' in c ? { entry: schemaEntryPointSchema.parse(c.entry) } : { reference: schemaReferenceDescriptorSchema.parse(c.reference), owner: c.owner };
      expect(unreadableListening(declarant, entries(positioned), descriptors) ?? null).toBe(c.refusal);
    });
  }
});

// The manifest read, in the words of crates/lf externals.rs
// `settings_become` (the same cases).
describe('a manifest listenSettingsBecome, as read', () => {
  for (const c of settingsBecome.manifestReads.cases) {
    it(c.name, () => {
      const read = WireListenDeclarations.safeParse({ listenSettingsBecome: c.raw });
      if (c.refusal !== null) {
        expect(read.success).toBe(false);
        expect(read.error?.issues[0]?.message).toBe(c.refusal);
      } else {
        expect(read.data?.listenSettingsBecome).toEqual(c.read);
      }
    });
  }
});

// The same cases listen-fire's describe reads (schema.rs
// `a_reference_declaring_fires_is_refused_naming_listenable`).
describe('a key 0.13 retired from an entry point, a reference or a manifest', () => {
  for (const c of retiredEntryKeys) {
    it(`${c.case} is ${c.refusal === null ? 'read' : 'refused by name'}`, () => {
      const keys = c.on === 'manifest' ? RETIRED_MANIFEST_KEYS : RETIRED_ENTRY_KEYS;
      expect(retiredEntryKey(c.name, c.declared, keys) ?? null).toBe(c.refusal);
    });
  }

  // The schemas an entry point and a reference are read by refuse it in the same words.
  const entry = { displayName: 'E', writable: false, readable: false };
  const { name: _named, ...unnamed } = reference;
  for (const c of retiredEntryKeys.filter((c) => c.on !== 'manifest' && c.refusal !== null)) {
    it(`${c.case} is refused by its schema in those words`, () => {
      const read =
        c.on === 'entry'
          ? schemaEntryPointSchema.safeParse({ ...entry, ...c.declared })
          : schemaReferenceDescriptorSchema.safeParse({ ...unnamed, ...c.declared });
      expect(read.success).toBe(false);
      expect(read.error?.issues.map((issue) => issue.message)).toContain(c.refusal);
    });
  }
});
