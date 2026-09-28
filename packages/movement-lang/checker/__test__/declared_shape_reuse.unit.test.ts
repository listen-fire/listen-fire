// A node declaration written once and reused. An extraction that takes it as
// its shape (`node entry: <Entry>`) must type EXACTLY as the inline block that
// spells the declaration out — same fields, same refinements, same nested
// nodes — and a write body's spread (`...e`, `?...e`) must be checked exactly
// as the field lines it stands for. These tests pin that sameness.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { ResolveFile } from '../link';

const crmSchema: InstanceSchema = {
  positions: {
    message: { properties: { Body: 'text' }, edges: {} },
    company: { properties: { name: 'text', stage: 'text', thesis: 'text' }, edges: {} },
  },
  collections: { message: { target: 'message' }, company: { target: 'company' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    company: {
      fields: { name: 'text', stage: 'text', thesis: 'text' },
      resultShape: { externalId: 'text', name: 'text', stage: 'text', thesis: 'text' },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    crm: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: crmSchema,
    },
  },
  credentials: { probe: { adapter: 'crm' } },
  plugins: { lookup: { args: ['q'] } },
});

const PRELUDE = [
  'import { crm } from adapters',
  'import { lookup } from plugins',
  'import { probe } from credentials',
  'graph = crm(credentials: probe)',
  'type Thesis = <"Consumer" | "Infra" | "Health">',
  'rules = "route by sector"',
].join('\n');

const ENTRY = [
  'node Entry: "each company pitched" {',
  '  name: <text> "the company\'s name"',
  '  stage: <text>',
  '  thesis: <Thesis> "the thesis it routes to. ${rules}"',
  '  node founder: "each founder named" { first: <text> "given names" }',
  '}',
].join('\n');

const errors = (source: string, resolveFile?: ResolveFile): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog, resolveFile ? { resolveFile } : undefined).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );

const program = (body: string[], declarations = ENTRY): string =>
  [PRELUDE, declarations, 'movement main(msg: <graph-[:message]->>) {', ...body, '}'].join('\n');

const codes = (body: string[], declarations = ENTRY): string[] =>
  errors(program(body, declarations)).map((d) => d.code);

const extractEntries = ['  found = extract from [msg.`Body`] {', '    node entry: <Entry>', '  }'];

describe('an extraction node that takes a declaration as its shape', () => {
  it('walks records of the declared structure — fields and nested nodes', () => {
    expect(
      codes([
        ...extractEntries,
        '  found-[e:entry]-> {',
        '    s = e.stage',
        '    e-[f:founder]-> { n = f.first }',
        '  }',
      ]),
    ).toEqual([]);
  });

  it('refuses a field the declaration does not have', () => {
    expect(codes([...extractEntries, '  found-[e:entry]-> { s = e.round }'])).toEqual([
      C.EXTRACT_UNKNOWN_FIELD,
    ]);
  });

  it('constrains a refinement field exactly as inline — a typo gets the did-you-mean', () => {
    const diagnostics = errors(
      program([...extractEntries, '  found-[e:entry]-> { ok = e.thesis == "Infrra" }']),
    );
    expect(diagnostics.map((d) => d.code)).toEqual([C.ENUM_UNKNOWN_VALUE]);
    expect(diagnostics[0].message).toContain('Did you mean "Infra"?');
  });

  it('types the same as the inline block the declaration spells out', () => {
    const inline = [
      '  found = extract from [msg.`Body`] {',
      '    node entry: "each company pitched" {',
      '      name: <text> "the company\'s name"',
      '      stage: <text> ""',
      '      thesis: <Thesis> "the thesis it routes to. ${rules}"',
      '      node founder: "each founder named" { first: <text> "given names" }',
      '    }',
      '  }',
    ];
    const uses = ['  found-[e:entry]-> {', '    write graph-[:company]-> { name: e.name }', '  }'];
    expect(codes([...extractEntries, ...uses])).toEqual(codes([...inline, ...uses]));
    expect(codes([...extractEntries, ...uses])).toEqual([C.ABSENT_REQUIRED]);
  });

  it('lets a following `through` stage read the declared fields, and nothing later', () => {
    const through = (arg: string): string[] =>
      codes([
        '  found = extract from [msg.`Body`] {',
        '    node entry: <Entry> "each deal"',
        `      through [lookup(q: ${arg})] { round: "the round, from the lookup" }`,
        '  }',
      ]).filter((code) => code !== C.PLUGIN_OUTPUT_UNDECLARED);
    expect(through('name')).toEqual([]);
    // The control: the stage's OWN field is a forward reference.
    expect(through('round')).toEqual([C.THROUGH_FORWARD_REF]);
  });

  it('refuses a name that is not a node declaration, naming the fix', () => {
    const diagnostics = errors(
      program(['  found = extract from [msg.`Body`] {', '    node entry: <Thesis>', '  }']),
    );
    expect(diagnostics.map((d) => d.code)).toEqual([C.EXTRACT_SHAPE_NOT_DECLARED]);
    expect(diagnostics[0].message).toContain("node Thesis: \"…\" { … }");
  });

  it('refuses an unknown name', () => {
    expect(
      codes(['  found = extract from [msg.`Body`] {', '    node entry: <Entyr>', '  }']),
    ).not.toEqual([]);
  });

  it('reuses an IMPORTED declaration', () => {
    const lib = ['export node Entry: "each company" {', '  name: <text> "its name"', '}'].join('\n');
    const source = [
      PRELUDE,
      'import { Entry } from "lib/entries"',
      'movement main(msg: <graph-[:message]->>) {',
      ...extractEntries,
      '  found-[e:entry]-> { n = e.name }',
      '}',
    ].join('\n');
    const resolve: ResolveFile = (path) => (path === 'lib/entries' ? { source: lib } : undefined);
    expect(errors(source, resolve).map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });
});

describe("a declaration's descriptions", () => {
  it('may interpolate a file-scope binding declared above it', () => {
    expect(codes([...extractEntries])).toEqual([]);
  });

  it('refuses one declared below it as read before it is bound', () => {
    const below = [
      'node Late: "each thing" {',
      '  name: <text> "named per ${later}"',
      '}',
      'later = "a rule"',
    ].join('\n');
    expect(codes([], below)).toContain(C.USE_BEFORE_BIND);
  });
});

describe('a spread in a write body', () => {
  const writeWith = (body: string): string[] => [
    ...extractEntries,
    '  found-[e:entry]-> {',
    `    write graph-[:company]-> { ${body} }`,
    '  }',
  ];

  it('`?...e` writes every field set-if-empty — clean', () => {
    // `founder` is a nested node, not a field: it is never spread.
    expect(codes(writeWith('unique by (name)  ?...e'))).toEqual([]);
  });

  it('`...e` refuses a maybe-absent field exactly as the plain line would, naming `?...`', () => {
    const diagnostics = errors(program(writeWith('...e')));
    expect(diagnostics.map((d) => d.code)).toEqual([
      C.ABSENT_REQUIRED,
      C.ABSENT_REQUIRED,
      C.ABSENT_REQUIRED,
    ]);
    expect(diagnostics[0].message).toContain("'?...e'");
  });

  it('refuses a field of `e` the target does not have, naming the field', () => {
    const target = crmSchema.writableRoots.company.fields;
    const narrow = [
      'node Entry: "each company" {',
      '  name: <text> "its name"',
      '  founded: <number> "the year"',
      '}',
    ].join('\n');
    expect(target.founded).toBeUndefined();
    const diagnostics = errors(program(writeWith('?...e'), narrow));
    expect(diagnostics.map((d) => d.code)).toEqual([C.WRITE_UNKNOWN_FIELD]);
    expect(diagnostics[0].message).toContain("has no field 'founded'");
    expect(diagnostics[0].message).toContain("'...e'");
  });

  it('an explicit line wins over the spread for its field', () => {
    // `name` written plainly from a value that is always there; the rest filled.
    expect(codes(writeWith('name: "fixed", ?...e'))).toEqual([]);
  });

  it('refuses a spread of something that is not an extracted record', () => {
    const diagnostics = errors(
      program(['  write graph-[:company]-> { ?...msg }']),
    );
    expect(diagnostics.map((d) => d.code)).toEqual([C.WRITE_SPREAD_SOURCE]);
    expect(diagnostics[0].message).toContain("write its fields out one per line");
  });
});
