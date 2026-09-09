// Value collections completed — dicts, the collection ops, and MEMBERS.
//
// A value collection is a list or a dict; positions keep the traversal-headed
// block. `{ k: v }` is the dict literal, `AT(d, k)` is the lookup, and the key
// world is text and nothing else. `MAP` / `FILTER` / `REDUCE` / `GROUPBY` /
// `KEYBY` take a FUNCTION, which is why they are read where `race` is rather
// than by the expression bridge. `MEMBERS(<T>)` is a closed type's values in
// the order they were declared.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text' },
      edges: {
        Messages: { target: 'message', readable: true, sequenced: 'chronological' },
        Members: { target: 'person', readable: true },
      },
    },
    message: { properties: { Text: 'text', At: 'datetime' }, edges: {} },
    person: { properties: { Name: 'text', Age: 'number' }, edges: {} },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { Name: 'text', Stage: { kind: 'enum', options: ['Seed', 'Series A'] } },
      edges: {},
    },
  },
  collections: { Companies: { target: 'company' } },
  writableRoots: {
    companies: {
      fields: {
        Name: 'text',
        // Open (known values) — other values are legal, so there is no complete
        // membership to walk.
        Tier: { kind: 'enum', options: ['gold', 'silver'], open: {} },
        Stage: { kind: 'enum', options: ['Seed', 'Series A'] },
      },
      resultShape: {},
      edges: {},
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    slack: { constructionArgs: [], schema: chatSchema },
    attio: { constructionArgs: [], schema: crmSchema },
  },
});

const PRELUDE = `import { slack, attio } from adapters
type Thesis = <"Consumer" | "Infra" | "Health">
chat = slack()
crm = attio()
`;

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
movement m(c: <chat-[:channel]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

describe('the dict literal', () => {
  it('a brace-led value is a dict, and a lookup off it may come up empty', () => {
    // Bound, then read — a value the write field must discharge, exactly as
    // every other maybe-absent read is.
    expect(codes('  d = { one: "a", two: "b" }\n  write chat-[:note]-> { Body ?: AT(d, "one") }')).toEqual([]);
  });

  it('the lookup is possibly absent, so an undischarged write is refused', () => {
    const body = '  d = { one: "a" }\n  write chat-[:note]-> { Body: AT(d, "one") }';
    expect(codes(body)).toContain('MOV_ABSENT_REQUIRED');
  });

  it('a non-text key is refused, naming the coercion to write', () => {
    const body = [
      '  d = { one: "a" }',
      '  n = 3',
      '  write chat-[:note]-> { Body ?: AT(d, n) }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_DICT_KEY_NOT_TEXT');
    expect(messages(body)).toContain('keyed by text');
  });

  it('a date key names DATE.FORMAT — the coercion that exists', () => {
    const body = [
      '  d = { one: "a" }',
      '  when = DATE("2026-01-01")',
      '  write chat-[:note]-> { Body ?: AT(d, when) }',
    ].join('\n');
    expect(messages(body)).toContain('DATE.FORMAT');
  });

  it('a literal whose values disagree is json, not a dict — nothing claims a shape for it', () => {
    // A json value is opaque, so folding it into text is the error that says
    // this is not a dict of text.
    expect(codes('  d = { a: "x", b: 3 }\n  t = CONCAT(d, "!")')).toContain('MOV_JSON_OPAQUE');
  });

  it('the retired inline block still refuses by name — the `.binding` tells them apart', () => {
    expect(codes('  x = { a = 1 }.a')).toContain('MOV_INLINE_BLOCK_RETIRED');
  });
});

describe('MAP / FILTER over a value collection', () => {
  const NAMES = '  names = COLLECT(c-[m:Messages]->.`Text`)\n';

  it("MAP's function takes one member, untyped — the collection says what it is", () => {
    expect(codes(`${NAMES}  loud = MAP(names, (t) => { return UPPER(t) })`)).toEqual([]);
  });

  it('the member keeps its type inside the function', () => {
    // A text member added up is an arithmetic error — proof the element type
    // reached the parameter.
    expect(
      codes(`${NAMES}  bad = MAP(names, (t) => { return t + 1 })`),
    ).toContain('MOV_ARITH_NON_NUMERIC');
  });

  it('an annotation on the parameter still wins where one is written', () => {
    expect(codes(`${NAMES}  n = MAP(names, (t: <text>) => { return UPPER(t) })`)).toEqual([]);
  });

  it('a function with the wrong number of parameters is refused', () => {
    const body = `${NAMES}  x = MAP(names, (a, b) => { return a })`;
    expect(codes(body)).toContain('MOV_COLLECTION_OP_ARITY');
    expect(messages(body)).toContain('one member at a time');
  });

  it('a function that hands nothing back is refused', () => {
    expect(codes(`${NAMES}  x = MAP(names, (t) => { y = t })`)).toContain(
      'MOV_COLLECTION_OP_RETURNS_NOTHING',
    );
  });

  it('a function that waits is refused, naming where waiting belongs', () => {
    const body = `${NAMES}  x = MAP(names, (t) => { await sleep(1d)\n    return t })`;
    expect(codes(body)).toContain('MOV_COLLECTION_OP_SUSPENDS');
    expect(messages(body)).toContain('parallel');
  });

  it('reading POSITIONS is refused, and the message names the traversal-headed block', () => {
    const body = '  x = MAP(c, (p) => { return p })';
    expect(codes(body)).toContain('MOV_COLLECTION_OP_NOT_A_COLLECTION');
    expect(messages(body)).toContain('traversal-headed block');
  });

  it('MAP preserves the input ordering: an unordered list stays unordered', () => {
    // Members are unordered, so a JOIN of what MAP made of them is the same
    // refusal a JOIN of the members would be.
    expect(
      codes([
        '  people = COLLECT(c-[p:Members]->.`Name`)',
        '  loud = MAP(people, (n) => { return "${n}!" })',
        '  t = JOIN(loud, ", ")',
      ].join('\n')),
    ).toContain('MOV_FOLD_NEEDS_ORDER');
  });

  it('…and an ordered one stays ordered', () => {
    expect(
      codes([
        '  lines = COLLECT(c-[m:Messages]->.`Text`)',
        '  loud = MAP(lines, (t) => { return "${t}!" })',
        '  joined = JOIN(loud, "\\n")',
      ].join('\n')),
    ).toEqual([]);
  });

  it('FILTER hands back the members it was given', () => {
    expect(
      codes([
        '  lines = COLLECT(c-[m:Messages]->.`Text`)',
        '  kept = FILTER(lines, (t) => { return t != "" })',
        '  joined = JOIN(kept, "\\n")',
      ].join('\n')),
    ).toEqual([]);
  });
});

describe('REDUCE is order-sensitive', () => {
  it('over an unordered collection it is refused, like every other order-sensitive fold', () => {
    const body = [
      '  ages = COLLECT(c-[p:Members]->.`Age`)',
      '  total = REDUCE(ages, 0, (carried, n) => { return carried + n })',
    ].join('\n');
    expect(codes(body)).toContain('MOV_FOLD_NEEDS_ORDER');
  });

  it('over an ordered one it is clean, and its value is what the function returns', () => {
    expect(
      codes([
        '  lines = COLLECT(c-[m:Messages]->.`Text`)',
        '  all = REDUCE(lines, "", (carried, t) => { return CONCAT(carried, t) })',
        '  write chat-[:note]-> { Body: all }',
      ].join('\n')),
    ).toEqual([]);
  });

  it('its function takes two things, and one is refused', () => {
    const body = [
      '  lines = COLLECT(c-[m:Messages]->.`Text`)',
      '  all = REDUCE(lines, "", (t) => { return t })',
    ].join('\n');
    expect(codes(body)).toContain('MOV_COLLECTION_OP_ARITY');
    expect(messages(body)).toContain('carried so far');
  });
});

describe('GROUPBY and KEYBY build dicts', () => {
  const LINES = '  lines = COLLECT(c-[m:Messages]->.`Text`)\n';

  it('a lookup into a dict may miss, so an undischarged write is refused', () => {
    // KEYBY's members are text, so this reads a text field directly — the
    // absence is the only thing left to report, which is what proves a
    // lookup can come up empty. (A JOIN would discharge it: joining nothing
    // is the empty string, the fold's own zero.)
    expect(
      codes([
        '  lines = COLLECT(c-[m:Messages]->.`Text`)',
        '  by = KEYBY(lines, (t) => { return "${t}!" })',
        '  write chat-[:note]-> { Body: AT(by, "A") }',
      ].join('\n')),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('a group discharged with COALESCE joins cleanly — the group keeps the source order', () => {
    expect(
      codes([
        '  lines = COLLECT(c-[m:Messages]->.`Text`)',
        '  by = GROUPBY(lines, (t) => { return "${t}!" })',
        '  write chat-[:note]-> { Body ?: JOIN(AT(by, "A"), ", ") }',
      ].join('\n')),
    ).toEqual([]);
  });

  it('a key that is not text is refused at the key function', () => {
    const body = [
      '  ages = COLLECT(c-[p:Members]->.`Age`)',
      '  by = GROUPBY(ages, (n) => { return n })',
    ].join('\n');
    expect(codes(body)).toContain('MOV_DICT_KEY_NOT_TEXT');
  });

  it('KEYBY hands back the member itself, not a list of them', () => {
    // The member is text, so joining the looked-up value is a type error —
    // proof KEYBY did not wrap it in a list.
    expect(
      codes([
        '  lines = COLLECT(c-[m:Messages]->.`Text`)',
        '  by = KEYBY(lines, (t) => { return "${t}!" })',
        '  write chat-[:note]-> { Body ?: AT(by, "A") }',
      ].join('\n')),
    ).toEqual([]);
  });
});

describe('MEMBERS — a closed type, in declaration order', () => {
  it('a declared refinement lists its values, and the list is ordered', () => {
    expect(
      codes('  all = MEMBERS(<Thesis>)\n  t = JOIN(all, ", ")'),
    ).toEqual([]);
  });

  it('the members are the type, so they key a dict of it', () => {
    expect(
      codes([
        '  lines = COLLECT(c-[m:Messages]->.`Text`)',
        '  by = GROUPBY(lines, (t) => { return "${t}!" })',
        '  all = MEMBERS(<Thesis>)',
        '  lines2 = MAP(all, (th) => { return JOIN(COALESCE(AT(by, th), []), ", ") })',
      ].join('\n')),
    ).toEqual([]);
  });

  it('written inside a collection op it is refused, naming the bind-first fix', () => {
    // A collection op and MEMBERS are read as their own statement (one takes a
    // function, the other a type — neither is an expression), so nesting one
    // gets a pointed refusal rather than a stray-character parse error.
    expect(() =>
      parseProgram(`${PRELUDE}\nmovement m(c: <chat-[:channel]->>) {\n  x = MAP(MEMBERS(<Thesis>), (t) => { return t })\n}`),
    ).toThrow(/bind it first/);
  });

  it('a borrowed CLOSED option set works the same way', () => {
    expect(codes('  all = MEMBERS(<crm-[:companies]->.`Stage`>)\n  t = JOIN(all, ", ")')).toEqual([]);
  });

  it('an OPEN known-values field is refused — its membership is not closed', () => {
    const body = '  all = MEMBERS(<crm-[:companies]->.`Tier`>)';
    expect(codes(body)).toContain('MOV_MEMBERS_NOT_CLOSED');
    expect(messages(body)).toContain('other values are legal');
  });

  it('a primitive is refused — there is nothing to list', () => {
    expect(codes('  all = MEMBERS(<text>)')).toContain('MOV_MEMBERS_NOT_CLOSED');
  });

  it('a name that is no type reports the ordinary unknown-type error', () => {
    expect(codes('  all = MEMBERS(<Nope>)')).toContain('MOV_UNKNOWN_TYPE_NAME');
  });
});

describe('a parameter with no type, where nothing supplies one', () => {
  it('a bare closure parameter is refused', () => {
    const body = '  f = (x) => { return x }';
    expect(codes(body)).toContain('MOV_PARAM_NEEDS_TYPE');
  });

  it('a movement parameter is refused too — its type is the promise to callers', () => {
    const source = `${PRELUDE}\nmovement other(x) {\n  y = x\n}`;
    expect(
      checkProgram(parseProgram(source), catalog)
        .filter((d) => (d.severity ?? 'error') === 'error')
        .map((d) => d.code),
    ).toContain('MOV_PARAM_NEEDS_TYPE');
  });
});
