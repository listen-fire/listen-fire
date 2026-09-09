// Checker coverage for what a bound traversal-headed block IS worth.
//
// Naming is not exporting: a block's bindings never leave it. The one way a
// value comes out is `return`, once per iteration — so a bound block's value is
// a LIST of the returned values, or the returned position itself (positions are
// many-valued already, so plurality lives in the traversal, not a second type).

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text' },
      edges: {
        Attachments: { target: 'attachment', readable: true },
        // The same edge, declared inherently sequenced — the block bound over
        // it collects its returns in that order.
        Parts: { target: 'attachment', readable: true, sequenced: 'document' },
      },
    },
    attachment: { properties: { Name: 'text', Pages: 'number' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: { email: { constructionArgs: [], schema: inboxSchema } },
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

function bindingType(body: string, name: string) {
  const { recording } = checkProgramWithLink(parseProgram(source(body)), catalog, {
    recordAnalysis: true,
  });
  const symbols = (recording?.frames ?? []).flatMap((f) => [...f.scope.symbols.values()]);
  return symbols.find((s) => s.name === name);
}

describe("a bound block's value is what its iterations returned", () => {
  it('a returned value binds as a list of the per-iteration type', () => {
    const body = '  names = e-[a:Attachments]-> {\n    return a.`Name`\n  }';
    expect(codes(body)).toEqual([]);
    // The head comes back in no particular order, so the collection does too —
    // the fact travels to whatever folds it.
    expect(bindingType(body, 'names')?.fieldType).toEqual({
      kind: 'list',
      of: 'text',
      unordered: true,
    });
  });

  it('a head the source keeps in order collects an ORDERED list', () => {
    const body = '  names = e-[a:Parts]-> {\n    return a.`Name`\n  }';
    expect(codes(body)).toEqual([]);
    expect(bindingType(body, 'names')?.fieldType).toEqual({ kind: 'list', of: 'text' });
    expect(codes(body + '\n  t = JOIN(names, ", ")')).toEqual([]);
  });

  it('JOIN over an unordered block collection is refused, naming the fix', () => {
    const body =
      '  names = e-[a:Attachments]-> {\n    return a.`Name`\n  }\n  t = JOIN(names, ", ")';
    expect(codes(body)).toContain('MOV_FOLD_NEEDS_ORDER');
    expect(messages(body)).toContain('no particular order');
  });

  it('a returned number lists as numbers', () => {
    const body = '  pages = e-[a:Attachments]-> {\n    return a.`Pages`\n  }';
    expect(bindingType(body, 'pages')?.fieldType).toEqual({
      kind: 'list',
      of: 'number',
      unordered: true,
    });
  });

  it('a returned node binds on the arrow plane and traverses', () => {
    const body =
      '  docs = e-[a:Attachments]-> {\n    return node { label: a.`Name` }\n  }\n'
      + '  t = docs.label';
    expect(codes(body)).toEqual([]);
    expect(bindingType(body, 'docs')?.bindingPlane).toBe('node');
  });

  it('a `return` inside an `if` arm is the block\'s return', () => {
    const body =
      '  names = e-[a:Attachments]-> {\n'
      + '    if a.`Pages` > 1 {\n      return a.`Name`\n    }\n'
      + '    return "none"\n  }';
    expect(codes(body)).toEqual([]);
    expect(bindingType(body, 'names')?.fieldType).toEqual({
      kind: 'list',
      of: 'text',
      unordered: true,
    });
  });

  it('two returns that disagree about the plane are refused', () => {
    const body =
      '  x = e-[a:Attachments]-> {\n'
      + '    if a.`Pages` > 1 {\n      return a.`Name`\n    }\n'
      + '    return node { label: "none" }\n  }';
    expect(codes(body)).toContain(C.RETURN_PLANE_MISMATCH);
  });
});

describe('a block that returns nothing has nothing to bind', () => {
  it('binding it is MOV_BLOCK_RETURNS_NOTHING, naming the return', () => {
    const body = '  x = e-[a:Attachments]-> {\n    n = a.`Name`\n  }';
    expect(codes(body)).toContain(C.BLOCK_RETURNS_NOTHING);
    expect(messages(body)).toContain('return');
  });

  it('leaving it unbound is fine — it ran for its effects', () => {
    expect(codes('  e-[a:Attachments]-> {\n    n = a.`Name`\n  }')).toEqual([]);
  });
});

describe('the retired read-back names its replacement', () => {
  const BLOCK = '  x = e-[a:Attachments]-> {\n'
    + '    n = a.`Name`\n'
    + '    return a.`Name`\n'
    + '  }\n';

  it('dot-reading an inner binding off the block is refused', () => {
    expect(codes(BLOCK + '  t = x.n')).toContain(C.BLOCK_READ_BACK_RETIRED);
    expect(messages(BLOCK + '  t = x.n')).toContain('return the value from the block');
  });

  it('traversing to an inner binding off the block is refused', () => {
    expect(codes(BLOCK + '  x-[v:n]-> {\n    q = 1\n  }')).toContain(C.BLOCK_READ_BACK_RETIRED);
  });
});
