// A record parameter carries what its body needs of the record it is handed.
//
// A system's record is OPAQUE: its fields are read one at a time, so a
// consumer that needs every field in hand (TEXT.SERIALISE, TEXT.PAIRS, a
// spread) refuses one. Inside a function, the parameter is typed by its
// declared shape (`e: <Entry>`), which holds its fields — so the body is
// accepted, and the REQUIREMENT moves to the call site: an argument whose
// fields are not in hand does not satisfy a parameter whose body needs them
// (TypeScript's parameter-versus-argument check, on the "fields in hand"
// capability). The requirement is inferred from the body, transitively.

import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C, type Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const crmSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text', tag: 'text' }, edges: { child: { target: 'person', writable: true } } },
    person: { properties: { first: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' } },
  supportsInPlaceUpdate: true,
  writableRoots: { company: { fields: { name: 'text', tag: 'text' }, resultShape: { externalId: 'text', name: 'text', tag: 'text' } } },
};
const sinkSchema: InstanceSchema = {
  positions: { row: { properties: { v: 'text', name: 'text', tag: 'text' }, edges: {} } },
  collections: { rows: { target: 'row' } },
  writableRoots: { row: { fields: { v: 'text', name: 'text', tag: 'text' }, resultShape: { externalId: 'text' } } },
};

const catalog = mockCatalog({
  adapters: {
    attio: { constructionArgs: [], schema: crmSchema },
    sheets: { constructionArgs: [], schema: sinkSchema },
  },
});

const PRELUDE = `import { attio, sheets } from adapters
src = attio()
sink = sheets()

node Entry {
  name: <text>
  tag: <text>
}
`;

function check(source: string, languageVersion: LanguageVersion = 3): Diagnostic[] {
  return checkProgram(parseProgram(PRELUDE + source, { languageVersion }), catalog, { languageVersion }).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (source: string, languageVersion?: LanguageVersion): string[] =>
  check(source, languageVersion).map((d) => d.code);
const messages = (source: string, languageVersion?: LanguageVersion): string =>
  check(source, languageVersion).map((d) => d.message).join('\n');

const USE_SER = `movement use_ser(e: <Entry>) {
  write sink-[:rows]-> { v: TEXT.SERIALISE(e, "JSON") }
}
`;

/** `run(…)` calls `use(e: <arg>)` once per company, with the record bound as
 *  `c`, after `pre` lines. */
const caller = (call: string, pre: string[] = []): string => `movement run(go: <src>) {
  src-[c:companies]-> {
${[...pre, call].map((l) => `    ${l}`).join('\n')}
  }
}
`;

describe('a record parameter carries what its body needs of the record', () => {
  it('reproduces the hole: a traversed system record handed to a body that serialises it is refused at the call', () => {
    const source = USE_SER + caller('use_ser(e: c)');
    expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
    const message = messages(source);
    expect(message).toContain("'use_ser'");
    expect(message).toContain("'e'");
    expect(message).toContain('TEXT.SERIALISE');
  });

  it('the same consumers over the record directly are refused by their own rules (the parity being restored)', () => {
    expect(codes(caller('write sink-[:rows]-> { v: TEXT.SERIALISE(c, "JSON") }'))).toEqual(['MOV_STDLIB_ARG_NOT_RECORD']);
  });

  it('a body that only reads fields one at a time takes a system record', () => {
    const source = `movement use_name(e: <Entry>) {
  write sink-[:rows]-> { v: e.name }
}
` + caller('use_name(e: c)');
    expect(codes(source)).toEqual([]);
  });

  it('a run-built record, a node literal and an extracted-shape record all pass', () => {
    const source = USE_SER + `movement run2(go: <src>) {
  deduped = node { entries: <Entry> order by arrival }
  a = write deduped-[:entries]-> { name: "Acme", tag: "a" }
  use_ser(e: a)
  deduped-[x:entries]-> {
    use_ser(e: x)
  }
  use_ser(e: node { name: "n", tag: "t" })
}
`;
    expect(codes(source)).toEqual([]);
  });

  it("a system write's own result holds its fields, and passes", () => {
    const source = USE_SER + `movement run2(go: <src>) {
  w = write src-[:companies]-> { name: "Gamma", tag: "g" }
  use_ser(e: w)
}
`;
    expect(codes(source)).toEqual([]);
  });

  it('a pick of a traversal is as opaque as the traversal', () => {
    const source = USE_SER + `movement run2(go: <src>) {
  x = FIRST(src-[:companies ORDER BY name]->)
  if x == null { ERROR("none") }
  use_ser(e: x)
}
`;
    expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
  });

  it.each([
    ['TEXT.PAIRS', 'write sink-[:rows]-> { v: TEXT.PAIRS(e) }', 'TEXT.PAIRS'],
    ['a map spread', 'm = { ...e, k: "1" }\n  write sink-[:rows]-> { v: m.k }', "'...'"],
    ['a write spread', 'write sink-[:rows]-> { ...e }', '...e'],
    ['an alias of the parameter', 'y = e\n  write sink-[:rows]-> { v: TEXT.SERIALISE(y, "JSON") }', 'TEXT.SERIALISE'],
    ['a list holding the parameter', 'write sink-[:rows]-> { v: TEXT.SERIALISE([e], "JSON") }', 'TEXT.SERIALISE'],
    ['a closure over the parameter', 'vs = MAP([e], (r) => { return TEXT.SERIALISE(r, "JSON") })\n  write sink-[:rows]-> { v: JOIN(vs, ",") }', 'TEXT.SERIALISE'],
  ])('%s needs the fields in hand', (_label, line, named) => {
    const source = `movement use(e: <Entry>) {
  ${line}
}
` + caller('use(e: c)');
    expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
    expect(messages(source)).toContain(named);
  });

  it('passing the parameter on carries the requirement: the outer call is refused, naming the chain', () => {
    const source = USE_SER + `movement outer(r: <Entry>) {
  use_ser(e: r)
}
` + caller('outer(r: c)');
    expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
    const message = messages(source);
    expect(message).toContain("'outer'");
    expect(message).toContain("'use_ser'");
    expect(message).toContain('TEXT.SERIALISE');
  });

  it('a call written above the declaration it calls is judged the same', () => {
    const source = caller('outer(r: c)') + `movement outer(r: <Entry>) {
  use_ser(e: r)
}
` + USE_SER;
    expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
  });

  it('a requirement through a call cycle is found (version 3 recursion)', () => {
    const source = `function ping(e: <Entry>, n: <number>) {
  if n > 0 { pong(e: e, n: n - 1) }
}
function pong(e: <Entry>, n: <number>) {
  if n > 0 { ping(e: e, n: n - 1) }
  write sink-[:rows]-> { v: TEXT.PAIRS(e) }
}
` + caller('ping(e: c, n: 2)');
    expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
  });

  it("the Morning Recap's shape stays clean: run-built entries handed to an upsert that spreads them", () => {
    const source = `node Deal {
  name: <text>
  tag: <text>
}
movement upsert_deal(d: <Deal>) {
  write sink-[:rows]-> { ...d }
}
movement recap(go: <src>) {
  entries = node { deals: <Deal> order by arrival }
  write entries-[:deals]-> { name: "Acme", tag: "a" }
  entries-[d:deals]-> {
    upsert_deal(d: d)
  }
}
`;
    expect(codes(source)).toEqual([]);
  });

  it.each([1, 2] as const)('version %i refuses the same call (a fix: it crashed at run time before)', (version) => {
    const source = `movement use_ser(e: <Entry>) {
  write sink-[:rows]-> { v: TEXT.PAIRS(e) }
}
` + caller('use_ser(e: c)');
    expect(codes(source, version)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
  });
});
