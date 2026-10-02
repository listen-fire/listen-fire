// List literals are TUPLES, and `...xs` splices a collection into one.
//
// `[m.Subject, 2]` is `[text, number]`: its slots were written down, so a
// literal index (`AT(t, 0)`) reads exactly one. Everywhere else a tuple is read
// as the list it widens to — TypeScript's tuple-to-array assignability — with
// the members' unified type as its element, which is the very type a list
// literal had before it was a tuple. A spread of a list makes the tuple
// VARIADIC (`[text, ...file[]]`); a spread of a tuple splices its slots.

import { parseProgram } from '../../parser/parse';
import { parseMovementExpression } from '../../expression/bridge';
import { checkProgram, checkProgramWithLink, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const mailSchema: InstanceSchema = {
  positions: {
    message: {
      properties: {
        Subject: 'text',
        Files: { kind: 'list', of: 'file' },
        Tags: { kind: 'list', of: 'text' },
      },
      edges: {},
    },
    log: { properties: { note: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' }, log: { target: 'log' } },
  writableRoots: {
    log: {
      fields: { note: 'text', Tags: { kind: 'list', of: 'text' } },
      requiredFields: [],
      resultShape: { externalId: 'text' },
    },
  },
};

const catalog = mockCatalog({
  adapters: { email: { constructionArgs: [], schema: mailSchema } },
});

function source(body: string): string {
  return `import { email } from adapters
inbox = email()

movement m(e: <inbox-[:message]->>) {
${body}
}`;
}

function check(body: string): Diagnostic[] {
  return checkProgram(parseProgram(source(body)), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

function fieldTypeOf(body: string, name: string): unknown {
  const { recording } = checkProgramWithLink(parseProgram(source(body)), catalog, {
    recordAnalysis: true,
  });
  const symbols = (recording?.frames ?? []).flatMap((f) => [...f.scope.symbols.values()]);
  return symbols.find((s) => s.name === name)?.fieldType;
}

describe('a spread parses inside a list literal, and only there', () => {
  const name = (n: string) => ({ type: 'property', propertyTypeId: n });

  it('at the start, in the middle and at the end', () => {
    expect(parseMovementExpression('[...xs, a]')).toEqual({
      type: 'list',
      elements: [{ type: 'spread', expression: name('xs') }, name('a')],
    });
    expect(parseMovementExpression('[a, ...xs, b]')).toEqual({
      type: 'list',
      elements: [name('a'), { type: 'spread', expression: name('xs') }, name('b')],
    });
    expect(parseMovementExpression('[a, ...xs]')).toEqual({
      type: 'list',
      elements: [name('a'), { type: 'spread', expression: name('xs') }],
    });
  });

  it('spreads any expression, not only a name', () => {
    expect(parseMovementExpression('[...COLLECT(xs)]')).toMatchObject({
      type: 'list',
      elements: [{ type: 'spread', expression: { type: 'aggregate', fn: 'collect' } }],
    });
  });

  it('a spread outside a list literal is refused, saying where it belongs', () => {
    const body = '  xs = [1, 2]\n  y = ...xs';
    expect(codes(body)).toContain('MOV_EXPR_PARSE');
    expect(messages(body)).toContain("only inside '[ … ]'");
  });
});

describe('a list literal is a tuple', () => {
  it('one slot per member, as written', () => {
    expect(fieldTypeOf('  t = [e.`Subject`, 2]', 't')).toEqual({ kind: 'tuple', of: ['text', 'number'] });
  });

  it('a literal index reads its own slot — present, because a fixed length has it', () => {
    const body = '  t = [e.`Subject`, 2]\n  a = AT(t, 0)\n  b = AT(t, 1)\n  c = AT(t, -1)\n  d = AT(t, 7)';
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 'a')).toEqual('text');
    expect(fieldTypeOf(body, 'b')).toEqual('number');
    expect(fieldTypeOf(body, 'c')).toEqual('number');
    expect(fieldTypeOf(body, 'd')).toEqual('absent');
  });

  it('a slot read off the literal directly is typed the same', () => {
    const body = '  a = AT([e.`Subject`, 2], 1)';
    expect(fieldTypeOf(body, 'a')).toEqual('number');
  });
});

describe('a spread splices into the tuple', () => {
  it('a list spread at the end makes a variadic tuple', () => {
    const body = '  t = [e.`Subject`, ...e.`Files`]';
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 't')).toEqual({ kind: 'tuple', of: ['text'], rest: { at: 1, of: 'file' } });
  });

  it('at the start', () => {
    expect(fieldTypeOf('  t = [...e.`Files`, e.`Subject`]', 't')).toEqual({
      kind: 'tuple',
      of: ['text'],
      rest: { at: 0, of: 'file' },
    });
  });

  it('in the middle', () => {
    expect(fieldTypeOf('  t = [e.`Subject`, ...e.`Files`, 3]', 't')).toEqual({
      kind: 'tuple',
      of: ['text', 'number'],
      rest: { at: 1, of: 'file' },
    });
  });

  it('a variadic tuple fixes only the slots on the near side of its run', () => {
    const body = [
      '  t = [e.`Subject`, ...e.`Files`, 3]',
      '  first = AT(t, 0)',
      '  second = AT(t, 1)',
      '  last = AT(t, -1)',
    ].join('\n');
    expect(fieldTypeOf(body, 'first')).toEqual('text');
    expect(fieldTypeOf(body, 'last')).toEqual('number');
    // Past the run's start a member may be a file, the 3, or nothing — and a
    // file and a number share no type.
    expect(fieldTypeOf(body, 'second')).toBeUndefined();
    expect(fieldTypeOf('  t = [e.`Subject`, ...e.`Files`]\n  s = AT(t, 1)', 's')).toEqual({
      kind: 'maybeAbsent',
      of: 'file',
    });
  });

  it("a tuple spread splices the tuple's own slots", () => {
    const body = '  p = [1, "a"]\n  t = [...p, TRUE]';
    expect(fieldTypeOf(body, 't')).toEqual({ kind: 'tuple', of: ['number', 'text', 'boolean'] });
  });

  it('a second run folds everything from the first onward into one, as TypeScript does', () => {
    expect(fieldTypeOf('  t = [e.`Subject`, ...e.`Files`, ...e.`Files`]', 't')).toEqual({
      kind: 'tuple',
      of: ['text'],
      rest: { at: 1, of: 'file' },
    });
  });

  it('a spread of one thing is refused — it has no members to splice', () => {
    const body = '  t = [1, ...e.`Subject`]';
    expect(codes(body)).toContain('MOV_LIST_SPREAD_NOT_A_LIST');
    expect(messages(body)).toContain('this is text');
  });

  it('a spread of a record is refused the same way', () => {
    expect(codes('  one = node { name: "Acme" }\n  t = [...one]')).toContain('MOV_LIST_SPREAD_NOT_A_LIST');
  });

  it('a spread that may be absent is refused — there would be nothing to splice', () => {
    const body = [
      '  d = { files: e.`Files` }',
      '  k = e.`Subject`',
      '  t = [...AT(d, k)]',
    ].join('\n');
    expect(codes(body)).toContain('MOV_ABSENT_REQUIRED');
  });
});

describe('a tuple read as a list is the list it widens to', () => {
  it('MAP reads the members as their unified type', () => {
    const body = '  t = [e.`Subject`, "x"]\n  u = MAP(t, (s) => { return s })';
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 'u')).toEqual({ kind: 'list', of: 'text' });
  });

  it('a variadic tuple widens through its run', () => {
    const body = '  t = [e.`Subject`, ...e.`Tags`]\n  u = MAP(t, (s) => { return s })';
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 'u')).toEqual({ kind: 'list', of: 'text' });
  });

  it('a tuple writes into a list field', () => {
    expect(codes('  write inbox-[:log]-> { Tags: [e.`Subject`, ...e.`Tags`] }')).toEqual([]);
    expect(codes('  t = [e.`Subject`, "x"]\n  write inbox-[:log]-> { Tags: t }')).toEqual([]);
  });

  it('nested literals widen at every depth, as a list of lists always typed', () => {
    const body = '  t = [[1, 2], [3]]\n  u = MAP(t, (row) => { return row })';
    expect(codes(body)).toEqual([]);
    expect(fieldTypeOf(body, 'u')).toEqual({ kind: 'list', of: { kind: 'list', of: 'number' } });
  });

  it('values that share no type read as a list nobody can type — silent, as before', () => {
    // `[1, "a"]` was an untyped list before it was a tuple; reading it as a
    // list stays exactly that, so nothing that validated stops validating.
    expect(codes('  j = JOIN([1, e.`Subject`], ", ")')).toEqual([]);
    expect(codes('  write inbox-[:log]-> { note: [1, e.`Subject`] }')).toEqual([]);
  });
});

describe('a record and a value in one literal', () => {
  const MIXED = '  one = node { name: "Acme" }\n  both = [one, e.`Subject`]';

  it('is a tuple, and accepted', () => {
    expect(codes(MIXED)).toEqual([]);
    expect(codes(`${MIXED}\n  s = AT(both, 1)`)).toEqual([]);
    expect(fieldTypeOf(`${MIXED}\n  s = AT(both, 1)`, 's')).toEqual('text');
  });

  it('is refused where it is read as a list — written into a list field', () => {
    const body = `${MIXED}\n  write inbox-[:log]-> { Tags: both }`;
    expect(codes(body)).toContain('MOV_LIST_MIXED');
    expect(messages(body)).toContain('one kind of thing');
  });

  it('is refused where it is read as a list — handed to MAP', () => {
    expect(codes(`${MIXED}\n  u = MAP(both, (b) => { return b })`)).toContain('MOV_LIST_MIXED');
  });

  it('is refused when written in place where a list is read', () => {
    expect(codes('  one = node { name: "Acme" }\n  n = COUNT([one, "label"])')).toContain('MOV_LIST_MIXED');
  });
});
