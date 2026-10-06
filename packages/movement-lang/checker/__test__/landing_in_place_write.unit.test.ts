// Checker coverage for `write e { … }` where `e` is a record the RUN built — a
// landing on a run-local node's edge.
//
// The engine has no in-place update for a record the run built: a position
// write needs a record in a system. So the checker must refuse it in every
// spelling that reaches such a record. The alias of a block head and a saved
// write result always were; a collection op's parameter was not — it is bound
// on the value plane, and the write-target rule heard nothing and stayed
// silent, so the run discovered the refusal once per member instead.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const inboxSchema: InstanceSchema = {
  positions: {
    message: { properties: { Subject: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

// A system that updates in place, so a collection op's parameter over ITS
// records has a write the checker can check field by field.
const crmSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  supportsInPlaceUpdate: true,
  writableRoots: { company: { fields: { name: 'text' }, resultShape: { externalId: 'text' } } },
};

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [], schema: inboxSchema },
    crm: { constructionArgs: [], schema: crmSchema },
  },
});

const PRELUDE = `import { email, crm } from adapters
inbox = email()
sys = crm()

node Company {
  name: <text>
  thesis: <text | null>
  website: <text | null>
}
`;

const SEED = `  deduped = node { companies: <Company> order by arrival }
  h = write deduped-[:companies]-> { unique by (FUZZY name)
    name: "Acme"
  }`;

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
movement m(msg: <inbox-[:message]->>) {
${SEED}
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}

const codes = (body: string): string[] => check(body).map((d) => d.code);

describe('an in-place write to a record the run built is refused at validation', () => {
  it('the saved write result', () => {
    expect(codes('  write h { thesis: "x" }')).toEqual([C.WRITE_POSITION_NOT_RECORD]);
  });

  it('the alias of a block head', () => {
    expect(
      codes(['  deduped-[e:companies]-> {', '    write e { thesis: "x" }', '  }'].join('\n')),
    ).toEqual([C.WRITE_POSITION_NO_UPDATE]);
  });

  it("MAP's parameter, over the hop", () => {
    const diagnostics = check(
      ['  MAP(deduped-[:companies]->, (e) => {', '    write e { thesis: "x" }', '  })'].join('\n'),
    );
    expect(diagnostics.map((d) => d.code)).toEqual([C.WRITE_POSITION_NO_UPDATE]);
    expect(diagnostics[0].message).toContain("'write e { … }'");
  });

  it("MAP's parameter, over a name bound to the hop", () => {
    expect(
      codes(
        [
          '  all = deduped-[:companies]->',
          '  MAP(all, (e) => {',
          '    write e { thesis: "x" }',
          '  })',
        ].join('\n'),
      ),
    ).toEqual([C.WRITE_POSITION_NO_UPDATE]);
  });

  it("MAP's parameter, over FILTER's answer", () => {
    expect(
      codes(
        [
          '  MAP(FILTER(deduped-[:companies]->, (e) => e.name == "Acme"), (e) => {',
          '    write e { thesis: "x" }',
          '  })',
        ].join('\n'),
      ),
    ).toEqual([C.WRITE_POSITION_NO_UPDATE]);
  });

  it("MAP's parameter, writing a field the record does not have", () => {
    // Refused for what it is first — no field check could rescue it — exactly
    // as the block-head alias is.
    const write = (alias: string) => `    write ${alias} { nope: "x" }`;
    expect(
      codes(['  MAP(deduped-[:companies]->, (e) => {', write('e'), '  })'].join('\n')),
    ).toEqual(codes(['  deduped-[e:companies]-> {', write('e'), '  }'].join('\n')));
    expect(
      codes(['  MAP(deduped-[:companies]->, (e) => {', write('e'), '  })'].join('\n')),
    ).toEqual([C.WRITE_POSITION_NO_UPDATE]);
  });

  it('the shape that failed in production: settings, COALESCE, a guarded second write', () => {
    expect(
      codes(
        [
          '  MAP(deduped-[:companies]->, { concurrency: 6, onError: "warn" }, (e) => {',
          '    write e {',
          '      name: COALESCE(e.thesis, e.name)',
          '      thesis: COALESCE(e.website, "none")',
          '    }',
          '    new_website = e.website',
          '    if new_website != null { write e { website: new_website } }',
          '  })',
        ].join('\n'),
      ),
    ).toEqual([C.WRITE_POSITION_NO_UPDATE, C.WRITE_POSITION_NO_UPDATE]);
  });
});

describe("a collection op's parameter is typed as the record it is", () => {
  it('reading a field it does not have is refused', () => {
    expect(
      codes(
        [
          '  MAP(deduped-[:companies]->, (e) => {',
          '    return e.nope',
          '  })',
        ].join('\n'),
      ),
    ).toContain(C.UNKNOWN_PROPERTY);
  });
});

describe("a collection op's parameter over a system's records writes like the hop's alias", () => {
  const over = (field: string) =>
    ['  MAP(sys-[:companies]->, (c) => {', `    write c { ${field}: "x" }`, '  })'].join('\n');

  it('a field the record has is accepted', () => {
    expect(codes(over('name'))).toEqual([]);
  });

  it('a field it does not have is refused, as it is for the alias', () => {
    const alias = ['  sys-[c:companies]-> {', '    write c { nope: "x" }', '  }'].join('\n');
    expect(codes(over('nope'))).toEqual(codes(alias));
    expect(codes(over('nope'))).toEqual([C.WRITE_UNKNOWN_FIELD]);
  });
});
