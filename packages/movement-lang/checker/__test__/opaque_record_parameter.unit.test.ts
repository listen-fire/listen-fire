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
  plugins: {
    // A plugin handed a record's fields all at once.
    summarise: {
      args: ['data'],
      argTypes: { data: 'json' },
      requiredArgs: ['data'],
      effects: { ai: true },
      output: { kind: 'value', type: 'text' },
    },
    // A plugin whose argument declares no type, and one that takes text.
    relay: { args: ['data'], requiredArgs: ['data'], effects: { ai: true }, output: { kind: 'value', type: 'text' } },
    shout: { args: ['data'], argTypes: { data: 'text' }, requiredArgs: ['data'], effects: { ai: true }, output: { kind: 'value', type: 'text' } },
  },
});

const PRELUDE = `import { attio, sheets } from adapters
import { summarise, relay, shout } from plugins
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

  describe('a record reached through the parameter is the caller\'s record\'s child', () => {
    it.each([
      ['a block head over its child', 'e-[k:child]-> {\n    write sink-[:rows]-> { v: TEXT.SERIALISE(k, "JSON") }\n  }'],
      ['MAP over its child', 'vs = MAP(e-[:child ORDER BY first]->, (k) => { return TEXT.SERIALISE(k, "JSON") })\n  write sink-[:rows]-> { v: JOIN(vs, ",") }'],
    ])('%s, serialised, needs the fields of the record in hand', (_label, line) => {
      const source = `node Holder {
  name: <text>
  node child {
    first: <text>
  }
}
movement use(e: <Holder>) {
  ${line}
}
` + caller('use(e: c)');
      expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
      expect(messages(source)).toContain('TEXT.SERIALISE');
    });

    it("a body that reads one field of the child takes a system record", () => {
      const source = `node Holder {
  name: <text>
  node child {
    first: <text>
  }
}
movement use(e: <Holder>) {
  e-[k:child]-> {
    write sink-[:rows]-> { v: k.first }
  }
}
` + caller('use(e: c)');
      expect(codes(source)).toEqual([]);
    });
  });

  describe("a plugin's json argument takes every field of the record", () => {
    it('a system record handed to it directly is refused, naming the plugin', () => {
      const source = caller('s = summarise(data: c)', []);
      expect(codes(source)).toEqual([C.CALL_ARG_TYPE]);
      expect(messages(source)).toContain("'summarise'");
    });

    it('a record the program holds passes, and so does a dict of the fields', () => {
      const source = `movement run2(go: <src>) {
  deduped = node { entries: <Entry> order by arrival }
  a = write deduped-[:entries]-> { name: "Acme", tag: "a" }
  s1 = summarise(data: a)
  src-[c:companies]-> {
    s2 = summarise(data: { name: c.name })
  }
}
`;
      expect(codes(source)).toEqual([]);
    });

    it('a function handing its parameter to it refuses a system record at the call', () => {
      const source = `movement use(e: <Entry>) {
  s = summarise(data: e)
  write sink-[:rows]-> { v: s }
}
` + caller('use(e: c)');
      expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
      expect(messages(source)).toContain("'summarise'");
    });
  });

  describe('a named closure with a record parameter carries the same requirement', () => {
    it('a closure that serialises its parameter refuses a system record at the call', () => {
      const source = `movement run2(go: <src>) {
  f = (e: <Entry>) => {
    write sink-[:rows]-> { v: TEXT.SERIALISE(e, "JSON") }
  }
  src-[c:companies]-> {
    f(e: c)
  }
}
`;
      expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
      const message = messages(source);
      expect(message).toContain("'f'");
      expect(message).toContain('TEXT.SERIALISE');
    });

    it('a closure that reads one field takes a system record; one that serialises takes a record in hand', () => {
      const source = `movement run2(go: <src>) {
  f = (e: <Entry>) => {
    write sink-[:rows]-> { v: e.name }
  }
  g = (e: <Entry>) => {
    write sink-[:rows]-> { v: TEXT.SERIALISE(e, "JSON") }
  }
  deduped = node { entries: <Entry> order by arrival }
  a = write deduped-[:entries]-> { name: "Acme", tag: "a" }
  g(e: a)
  src-[c:companies]-> {
    f(e: c)
  }
}
`;
      expect(codes(source)).toEqual([]);
    });

    it('a closure passing its parameter on to a function that serialises carries the need', () => {
      const source = USE_SER + `movement run2(go: <src>) {
  f = (r: <Entry>) => {
    use_ser(e: r)
  }
  src-[c:companies]-> {
    f(r: c)
  }
}
`;
      expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
      expect(messages(source)).toContain("'use_ser'");
    });

    it('a closure handing its parameter back gives the caller its own record again', () => {
      const source = `movement run2(go: <src>) {
  f = (e: <Entry>) => {
    return e
  }
  deduped = node { entries: <Entry> order by arrival }
  a = write deduped-[:entries]-> { name: "Acme", tag: "a" }
  b = f(e: a)
  write sink-[:rows]-> { v: TEXT.SERIALISE(b, "JSON") }
  src-[c:companies]-> {
    f(e: c)
  }
}
`;
      expect(codes(source)).toEqual([]);
    });
  });

  describe("what a body needs of the records reached through the parameter is asked of the caller's record's children", () => {
    const HOLDER = `node Holder {
  name: <text>
  node child {
    first: <text>
  }
}
`;
    const SER_CHILD = `movement ser_child(e: <Holder>) {
  e-[k:child]-> {
    write sink-[:rows]-> { v: TEXT.SERIALISE(k, "JSON") }
  }
}
`;

    it("a system write's result holds its own fields but not its children's: refused", () => {
      const source = HOLDER + SER_CHILD + `movement run2(go: <src>) {
  w = write src-[:companies]-> { name: "Gamma", tag: "g" }
  ser_child(e: w)
}
`;
      expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
      const message = messages(source);
      expect(message).toContain("the records 'e' leads to");
      expect(message).toContain('TEXT.SERIALISE');
    });

    it("the same function takes a run-built record, whose children the run holds", () => {
      const source = HOLDER + SER_CHILD + `movement run2(go: <src>) {
  deduped = node { entries: <Holder> order by arrival }
  a = write deduped-[:entries]-> { name: "Acme" }
  write a-[:child]-> { first: "Ann" }
  ser_child(e: a)
}
`;
      expect(codes(source)).toEqual([]);
    });

    it("a system write's result handed to a body that reads its child's field one at a time passes", () => {
      const source = HOLDER + `movement read_child(e: <Holder>) {
  e-[k:child]-> {
    write sink-[:rows]-> { v: k.first }
  }
}
movement run2(go: <src>) {
  w = write src-[:companies]-> { name: "Gamma", tag: "g" }
  read_child(e: w)
}
`;
      expect(codes(source)).toEqual([]);
    });

    it('a child passed on to a function that serialises it carries the need to the outer call', () => {
      const source = HOLDER + `node Person {
  first: <text>
}
movement ser_one(k: <Person>) {
  write sink-[:rows]-> { v: TEXT.SERIALISE(k, "JSON") }
}
movement walk(e: <Holder>) {
  e-[k:child]-> {
    ser_one(k: k)
  }
}
movement run2(go: <src>) {
  w = write src-[:companies]-> { name: "Gamma", tag: "g" }
  walk(e: w)
}
`;
      expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
      expect(messages(source)).toContain("'ser_one'");
    });
  });

  describe("a collection op binds its function's annotated record parameter to each member", () => {
    it('a serialising closure over a system collection is refused', () => {
      const source = `movement run2(go: <src>) {
  vs = MAP(src-[:companies ORDER BY name]->, (e: <Entry>) => { return TEXT.SERIALISE(e, "JSON") })
  write sink-[:rows]-> { v: JOIN(vs, ",") }
}
`;
      expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
      const message = messages(source);
      expect(message).toContain("'MAP'");
      expect(message).toContain('TEXT.SERIALISE');
    });

    it('a field-reading closure over a system collection, and a serialising one over run-built records, pass', () => {
      const source = `movement run2(go: <src>) {
  names = MAP(src-[:companies ORDER BY name]->, (e: <Entry>) => { return e.name })
  deduped = node { entries: <Entry> order by arrival }
  write deduped-[:entries]-> { name: "Acme", tag: "a" }
  vs = MAP(deduped-[:entries]->, (e: <Entry>) => { return TEXT.SERIALISE(e, "JSON") })
  write sink-[:rows]-> { v: JOIN(vs, ",") }
  write sink-[:rows]-> { v: JOIN(names, ",") }
}
`;
      expect(codes(source)).toEqual([]);
    });

    it('a named closure handed to the op is held to the same requirement', () => {
      const source = `movement run2(go: <src>) {
  f = (e: <Entry>) => { return TEXT.SERIALISE(e, "JSON") }
  vs = MAP(src-[:companies ORDER BY name]->, f)
  write sink-[:rows]-> { v: JOIN(vs, ",") }
}
`;
      expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD]);
      expect(messages(source)).toContain("'f'");
    });

    it('FILTER and REDUCE bind their member the same way', () => {
      const source = `movement run2(go: <src>) {
  kept = FILTER(src-[:companies ORDER BY name]->, (e: <Entry>) => { return TEXT.PAIRS(e) != "" })
  folded = REDUCE(src-[:companies ORDER BY name]->, "", (acc, e: <Entry>) => { return "\${acc}\${TEXT.PAIRS(e)}" })
  write sink-[:rows]-> { v: folded }
  write sink-[:rows]-> { v: "\${COUNT(kept)}" }
}
`;
      expect(codes(source)).toEqual([C.CALL_ARG_OPAQUE_RECORD, C.CALL_ARG_OPAQUE_RECORD]);
    });
  });

  describe("a write or a node literal written in place as a plugin's json argument", () => {
    it.each([
      ['a write', 'summarise(data: write src-[:companies]-> { name: "Gamma", tag: "g" })', 'a write'],
      ['a node literal', 'summarise(data: node { name: "n", tag: "t" })', "'node { … }'"],
    ])('%s is refused, naming what was passed and what the plugin takes', (_label, call, named) => {
      const source = `movement run2(go: <src>) {
  s = ${call}
  write sink-[:rows]-> { v: s }
}
`;
      expect(codes(source)).toEqual([C.CALL_ARG_TYPE]);
      const message = messages(source);
      expect(message).toContain("'summarise'");
      expect(message).toContain('structured data');
      expect(message).toContain(named);
    });
  });

  describe('a plugin argument written in place that is no expression is refused, whatever the argument takes', () => {
    const FORMS: Array<[string, string, string]> = [
      ['a write', 'write src-[:companies]-> { name: "Gamma", tag: "g" }', 'a write'],
      ['a node literal', 'node { name: "n", tag: "t" }', "'node { … }'"],
      ['a call', 'summarise(data: { name: "n" })', "a call to 'summarise'"],
      ["a built-in's call", 'UPPER("n")', "a call to 'UPPER'"],
    ];
    const PLUGINS: Array<[string, string]> = [
      ['relay', 'a value'],
      ['shout', 'text'],
      ['summarise', 'structured data'],
    ];
    it.each(PLUGINS.flatMap(([plugin, takes]) => FORMS.map(([label, arg, named]) => [plugin, label, arg, named, takes] as const)))(
      "'%s' given %s",
      (plugin, _label, arg, named, takes) => {
        const source = `movement run2(go: <src>) {
  s = ${plugin}(data: ${arg})
  write sink-[:rows]-> { v: s }
}
`;
        expect(codes(source)).toEqual([C.CALL_ARG_TYPE]);
        const message = messages(source);
        expect(message).toContain(`'${plugin}'`);
        expect(message).toContain(named);
        expect(message).toContain(takes);
      },
    );

    it.each([
      ['a function', '(r) => { return r }', 'a function written in place'],
      ['a type', '<Entry>', 'a type'],
    ])('%s is refused once, by the rule every argument has', (_label, arg, named) => {
      const source = `movement run2(go: <src>) {
  s = relay(data: ${arg})
  write sink-[:rows]-> { v: s }
}
`;
      expect(codes(source)).toEqual([C.CALL_ARG_TYPE]);
      expect(messages(source)).toContain(named);
    });

    it('the same values bound to a name first, and an expression, pass', () => {
      const source = `movement run2(go: <src>) {
  n = node { name: "n", tag: "t" }
  v = summarise(data: { name: "n" })
  s1 = relay(data: n)
  s2 = relay(data: v)
  s3 = shout(data: v)
  s4 = summarise(data: n)
  u = UPPER(v)
  s5 = relay(data: u)
  write sink-[:rows]-> { v: "\${s1}\${s2}\${s3}\${s4}\${s5}" }
}
`;
      expect(codes(source)).toEqual([]);
    });
  });
});
