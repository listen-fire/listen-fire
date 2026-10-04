// Checker coverage for the extraction CALL — `extract(content, Shape, config?)`.
//
// Content in, a list of `Shape` records out. The shape is a node declaration
// the checker can see (named, local to a body, or written in place); the
// records read by the keyword's rule for an extracted declaration (plain text
// present, anything typed maybe absent); the settings are written down and
// checked key by key, the model against what this deployment reaches.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import { TypedDiagnosticCodes } from '../typing';

const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text', Body: 'text', Count: 'number', Payload: 'json', Files: { kind: 'list', of: 'file' } },
      edges: { Attachments: { target: 'attachment', readable: true } },
    },
    attachment: {
      properties: { Name: 'text', Type: 'text', File: 'file' },
      edges: {},
    },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

const PRELUDE = `import { email } from adapters
inbox = email()

node Company: "each company named in this message" {
  name: <text> "the company's name"
  employees: <number> "its headcount"
  website: <text | null> "its website"
  node round: "each funding round it raised" {
    stage: <text> "the stage"
  }
}

node CompanyDetail: "more about the company described last" {
  summary: <text> "one line on what it does"
}
`;

function check(body: string, options: { models?: readonly string[] } = {}): Diagnostic[] {
  const source = `${PRELUDE}
movement under_test(e: <inbox-[:message]->>) {
${body}
}`;
  const catalog = mockCatalog({
    adapters: { email: { constructionArgs: [], schema: inboxSchema } },
    ...(options.models !== undefined ? { models: options.models } : {}),
  });
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string, options?: { models?: readonly string[] }): string[] =>
  check(body, options).map((d) => d.code);
const messages = (body: string, options?: { models?: readonly string[] }): string =>
  check(body, options).map((d) => d.message).join('\n');

const CONTENT = "content = [e.Body, ...e.`Files`]";

describe('extract(content, Shape) — the worked example', () => {
  it('extracts, then maps over the records with a per-record extraction', () => {
    expect(
      codes(
        [
          `  ${CONTENT}`,
          "  companies = extract(content, Company, { tier: 'careful' })",
          "  detailed = MAP(companies, { initialConcurrency: 1, concurrency: 4, onError: 'warn' }, (c) => {",
          "    found = extract([...content, TEXT.SERIALISE(c, 'JSON')], CompanyDetail, { tier: 'careful' })",
          '    return ONLY(found)',
          '  })',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('nests inside another expression as the records it finds', () => {
    expect(codes("  first = ONLY(extract([e.Body], Company))")).toEqual([]);
    // Typed by its shape: a Company's headcount is a number, which UPPER refuses.
    expect(codes("  n = UPPER(ONLY(MAP(extract([e.Body], Company), (r) => r.employees)))")).toEqual([
      TypedDiagnosticCodes.BUILTIN_ARG_TYPE,
    ]);
    expect(codes("  n = UPPER(ONLY(MAP(extract([e.Body], Company), (r) => r.name)))")).toEqual([]);
  });

  it('is an expression: it may be returned', () => {
    expect(codes('  return extract([e.Body], Company)')).toEqual([]);
  });
});

describe('the records it hands back', () => {
  const each = (lines: string[]): string[] =>
    codes(
      [
        '  companies = extract([e.Body], Company)',
        '  MAP(companies, (c) => {',
        ...lines.map((l) => `    ${l}`),
        '  })',
      ].join('\n'),
    );

  it('read the shape\'s fields, and nothing else', () => {
    expect(each(['n = c.name', 'w = c.website', 'k = c.employees'])).toEqual([]);
    expect(each(['x = c.nmae'])).toEqual([TypedDiagnosticCodes.UNKNOWN_PROPERTY]);
  });

  it('read plain text as present and a typed field as maybe absent', () => {
    expect(each(['big = c.name > "M"'])).toEqual([]);
    expect(each(['big = c.employees > 10'])).toEqual([TypedDiagnosticCodes.ABSENT_REQUIRED]);
    expect(each(['big = COALESCE(c.employees, 0) > 10'])).toEqual([]);
  });

  it('walk to nested records, with a WHERE on the hop', () => {
    expect(
      each([
        'c-[r:round WHERE r.stage = "Seed"]-> {',
        '  s = r.stage',
        '}',
      ]),
    ).toEqual([]);
    expect(each(['c-[r:rounds]-> { s = r.stage }'])).not.toEqual([]);
  });

  it('take writes and links into their nested edges, in the run', () => {
    expect(each(['write c-[:round]-> { stage: "Series A" }'])).toEqual([]);
  });

  it('pick one with ONLY, and serialise to text for a later call', () => {
    expect(
      codes(
        [
          '  companies = extract([e.Body], Company)',
          '  first = ONLY(companies)',
          "  more = extract([e.Body, TEXT.SERIALISE(first, 'JSON')], CompanyDetail)",
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('the shape', () => {
  it('may be written in place, with the declaration\'s own header', () => {
    expect(
      codes(
        [
          '  people = extract([e.Body], node Person: "each person named" {',
          '    name: <text> "their name"',
          '    role: <text | null> "their role"',
          '  })',
          '  MAP(people, (p) => { n = p.name })',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('written in place, is checked by the declaration\'s own path', () => {
    expect(
      codes('  people = extract([e.Body], node Person: "each person" { age: <nubmer> "their age" })'),
    ).toEqual([C.UNKNOWN_TYPE_NAME]);
  });

  it('written in place, names the shape for the call and nothing after it', () => {
    expect(
      codes(
        [
          '  people = extract([e.Body], node Person: "each person" { name: <text> "their name" })',
          '  again = extract([e.Body], Person)',
        ].join('\n'),
      ),
    ).not.toEqual([]);
  });

  it('may be declared in the body around the call', () => {
    expect(
      codes(
        [
          '  companies = extract([e.Body], Company)',
          '  MAP(companies, (c) => {',
          '    node Founder: "each founder of the company described last" { name: <text> "their name" }',
          "    founders = extract([e.Body, TEXT.SERIALISE(c, 'JSON')], Founder)",
          '    return founders',
          '  })',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('refuses a name that is not a node declaration — a computed shape types nothing', () => {
    const body = ['  which = "Company"', '  found = extract([e.Body], which)'].join('\n');
    expect(codes(body)).toEqual([C.EXTRACT_SHAPE_COMPUTED]);
    expect(messages(body)).toContain('node declaration');
  });

  it('refuses a shape worked out by an expression', () => {
    expect(codes('  found = extract([e.Body], COALESCE(e.Subject, "x"))')).toEqual([
      C.EXTRACT_SHAPE_COMPUTED,
    ]);
  });

  it('refuses a name nothing declares', () => {
    expect(codes('  found = extract([e.Body], Compnay)')).not.toEqual([]);
  });
});

describe('the content', () => {
  it('takes text and files, spread lists included', () => {
    expect(codes(`  ${CONTENT}\n  found = extract(content, Company)`)).toEqual([]);
  });

  it('refuses a record, with the TEXT.SERIALISE fix', () => {
    const body = [
      '  companies = extract([e.Body], Company)',
      '  MAP(companies, (c) => {',
      '    more = extract([e.Body, c], CompanyDetail)',
      '  })',
    ].join('\n');
    expect(codes(body)).toEqual([C.EXTRACT_CONTENT]);
    expect(messages(body)).toContain("TEXT.SERIALISE(record, 'JSON')");
  });

  it('refuses a record handed over bare, with the fix spelled for it', () => {
    expect(codes('  found = extract(e, Company)')).toEqual([C.EXTRACT_CONTENT]);
    expect(messages('  found = extract(e, Company)')).toContain("TEXT.SERIALISE(e, 'JSON')");
  });

  it('refuses a graph value — it is a record too', () => {
    const body = [
      '  g = graph<CompanyDetail> { summary: e.Body }',
      '  found = extract([g], Company)',
    ].join('\n');
    expect(codes(body)).toEqual([C.EXTRACT_CONTENT]);
  });

  it('refuses one value where a list goes', () => {
    expect(codes('  found = extract(e.Body, Company)')).toEqual([C.EXTRACT_CONTENT]);
    expect(messages('  found = extract(e.Body, Company)')).toContain('extract([e.Body], …)');
  });

  it('refuses json and numbers, which are not text', () => {
    expect(codes('  found = extract([e.Payload], Company)')).toEqual([C.EXTRACT_CONTENT]);
    expect(codes('  found = extract([e.Count], Company)')).toEqual([C.EXTRACT_CONTENT]);
  });

  it('refuses a list inside the list, with the spread', () => {
    const body = '  found = extract([e.Body, e.`Files`], Company)';
    expect(codes(body)).toEqual([C.EXTRACT_CONTENT]);
    expect(messages(body)).toContain('...items');
  });
});

describe('the settings', () => {
  it('take a tier, an effort and a model', () => {
    expect(
      codes("  found = extract([e.Body], Company, { tier: 'thorough', effort: 'medium', model: 'claude-opus-5' })"),
    ).toEqual([]);
  });

  it('refuse an unknown key, with a did-you-mean', () => {
    const body = "  found = extract([e.Body], Company, { teir: 'quick' })";
    expect(codes(body)).toEqual([C.EXTRACT_CONFIG]);
    expect(messages(body)).toContain("did you mean 'tier'");
  });

  it('refuse a tier or an effort outside their words', () => {
    expect(codes("  found = extract([e.Body], Company, { tier: 'carefull' })")).toEqual([C.EXTRACT_CONFIG]);
    expect(messages("  found = extract([e.Body], Company, { tier: 'carefull' })")).toContain("did you mean 'careful'");
    expect(codes("  found = extract([e.Body], Company, { effort: 'max' })")).toEqual([C.EXTRACT_CONFIG]);
  });

  it('refuse a value worked out rather than written down', () => {
    expect(codes('  t = "quick"\n  found = extract([e.Body], Company, { tier: t })')).toEqual([C.EXTRACT_CONFIG]);
  });

  it('check the model against what this deployment reaches, when that is known', () => {
    const models = ['claude-sonnet-5', 'claude-opus-5'];
    expect(codes("  found = extract([e.Body], Company, { model: 'claude-opus-5' })", { models })).toEqual([]);
    const body = "  found = extract([e.Body], Company, { model: 'claude-opus-6' })";
    expect(codes(body, { models })).toEqual([C.EXTRACT_CONFIG]);
    expect(messages(body, { models })).toContain("did you mean 'claude-opus-5'");
    expect(messages(body, { models })).toContain('not a model this deployment reaches');
    // Nobody said what this deployment reaches: nothing is refused.
    expect(codes(body)).toEqual([]);
  });
});

describe('the syntax', () => {
  it('refuses the anonymous node literal as a shape — its strings are values', () => {
    const source = `${PRELUDE}
movement under_test(e: <inbox-[:message]->>) {
  found = extract([e.Body], node { name: "x" })
}`;
    expect(() => parseProgram(source)).toThrow(/not a shape/);
  });

  it('refuses a bare extraction call — what it found has to go somewhere', () => {
    const source = `${PRELUDE}
movement under_test(e: <inbox-[:message]->>) {
  extract([e.Body], Company)
}`;
    expect(() => parseProgram(source)).toThrow(/bound to a name/);
  });

  it('is language version 3: under version 2, extract( is the parse error it always was', () => {
    const source = `${PRELUDE}
movement under_test(e: <inbox-[:message]->>) {
  found = extract([e.Body], Company)
}`;
    expect(() => parseProgram(source, { languageVersion: 2 })).toThrow(/from/);
    expect(() => parseProgram(source, { languageVersion: 3 })).not.toThrow();
  });

  it('leaves the keyword exactly as it was', () => {
    const source = `${PRELUDE}
movement under_test(e: <inbox-[:message]->>) {
  found = extract "careful" from [e.Body] {
    node company: <Company>
  }
}`;
    const program = parseProgram(source);
    const movement = program.statements.find((s) => s.kind === 'movement');
    expect(movement?.kind === 'movement' && movement.body[0]).toMatchObject({
      kind: 'assign',
      value: { kind: 'extract' },
    });
  });

  it('a shape written in place with a field and a child of one name is refused', () => {
    const body = [
      '  found = extract([e.`Subject`], node Firm: "each firm" {',
      '    round: <text> "the latest round"',
      '    node round: "each funding round" { stage: <text> "the stage" }',
      '  })',
    ].join('\n');
    expect(codes(body)).toEqual([C.EXTRACT_FIELD_DUPLICATE]);
  });
});
