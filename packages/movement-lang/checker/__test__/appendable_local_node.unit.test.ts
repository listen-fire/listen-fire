// Checker coverage for the appendable run-local node — a node literal entry
// that DECLARES an edge and starts it empty, and `link` appending landings to
// it as the run goes.
//
// The two facts worth pinning: the declared edge's type is the address WALKED
// (so traversing it afterwards is the ordinary traversal), and a `link` onto it
// is checked STRUCTURALLY — a local node belongs to no graph, so there is
// nothing nominal to compare by and nothing for the effect row to carry.

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink, Diagnostic, DiagnosticCodes as C } from '../check';
import { effectRowOf, type EffectRow } from '../effects';
import { InstanceSchema, mockCatalog } from '../catalog';

// The event source — the movement's parameter, plus one lazy-able edge.
const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text', Count: 'number' },
      edges: { Attachments: { target: 'attachment', readable: true } },
    },
    attachment: { properties: { Name: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

// The written graph: channels carry messages, messages carry replies, and
// people are the WRONG type to land on a messages edge.
const chatSchema: InstanceSchema = {
  positions: {
    Channel: {
      properties: { Name: 'text' },
      edges: { Messages: { target: 'ChatMessage', readable: true, writable: true } },
    },
    ChatMessage: {
      properties: { Text: 'text' },
      edges: { Replies: { target: 'ChatMessage', readable: true, writable: true } },
    },
    Person: { properties: { Email: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'Channel' }, People: { target: 'Person' } },
  writableRoots: {
    Channel: { fields: { Name: 'text' }, resultShape: { externalId: 'text' } },
    ChatMessage: { fields: { Text: 'text' }, resultShape: { externalId: 'text' } },
    Person: { fields: { Email: 'text' }, resultShape: { externalId: 'text' } },
  },
};

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [], schema: inboxSchema },
    chat: { constructionArgs: [], schema: chatSchema },
  },
});

const PRELUDE = `import { email, chat } from adapters
inbox = email()
sl = chat()
`;

const DECLARED = 'sent = node { messages: <sl-[:Channels]->-[:Messages]->> }';

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
movement m(e: <inbox-[:message]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}

const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

function rowOf(body: string): EffectRow {
  const source = `${PRELUDE}
movement m(e: <inbox-[:message]->>) {
${body}
}`;
  const { recording } = checkProgramWithLink(parseProgram(source), catalog, {
    recordAnalysis: true,
  });
  const file = recording?.frames.find((frame) => frame.kind === 'file');
  const symbol = file?.scope.symbols.get('m');
  if (symbol === undefined) throw new Error("'m' is not declared");
  const row = effectRowOf(symbol);
  if (row === undefined) throw new Error("'m' has no inferred row");
  return row;
}

describe('a declared edge is the address, walked', () => {
  it('types its landings, so a traversal reads their fields', () => {
    expect(codes(`  ${DECLARED}\n  sent-[x:messages]-> {\n    t = x.Text\n  }`)).toEqual([]);
  });

  it('a field the landing type does not carry is refused through it', () => {
    expect(codes(`  ${DECLARED}\n  sent-[x:messages]-> {\n    t = x.Nope\n  }`)).toContain(
      C.UNKNOWN_PROPERTY,
    );
  });

  it('an edge the address graph does not have is told at the declaration', () => {
    expect(codes('  sent = node { messages: <sl-[:Channels]->-[:Nope]->> }')).toContain(
      'MOV_TRAVERSE_UNKNOWN_EDGE',
    );
  });

  it('reading it by DOT is refused — it is an edge, not a field', () => {
    expect(codes(`  ${DECLARED}\n  x = sent.messages`)).toContain(C.UNKNOWN_PROPERTY);
  });
});

describe('link appends a landing', () => {
  const written = `  ch = write sl-[:Channels]-> { Name: "general" }
  one = write ch-[:Messages]-> { Text: "hi" }`;

  it('a conforming write handle is accepted', () => {
    expect(codes(`  ${DECLARED}\n${written}\n  link sent -[:messages]-> one`)).toEqual([]);
  });

  it('a handle of the wrong type is refused, with both types named', () => {
    const body = `  ${DECLARED}
  p = write sl-[:People]-> { Email: "a@b.com" }
  link sent -[:messages]-> p`;
    expect(codes(body)).toContain(C.NODE_LINK_SHAPE);
    expect(messages(body)).toMatch(/ChatMessage/);
    expect(messages(body)).toMatch(/Person/);
  });

  it('a traversed position of the landing type is accepted — any position lands', () => {
    const body = `  ${DECLARED}
  sl-[:Channels]->-[msg:Messages]-> {
    link sent -[:messages]-> msg
  }`;
    expect(codes(body)).toEqual([]);
  });

  it('an edge the literal never declared is refused, naming what it has', () => {
    const body = `  ${DECLARED}\n${written}\n  link sent -[:nope]-> one`;
    expect(codes(body)).toContain(C.NODE_EDGE_UNDECLARED);
    expect(messages(body)).toMatch(/messages/);
  });

  it('a lazy entry is refused — its landings are recomputed at every read', () => {
    const body = `  sent = node { files: lazy e-[a:Attachments]-> }
${written}
  link sent -[:files]-> one`;
    expect(codes(body)).toContain(C.NODE_EDGE_DEFERRED);
  });

  it('a criteria body is refused — a node this run built has no system to search', () => {
    const body = `  ${DECLARED}\n  link sent -[:messages]-> { Text: "hi" }`;
    expect(codes(body)).toContain(C.NODE_LINK_CRITERIA);
  });
});

describe('what the link does NOT change', () => {
  it('a link inside an if arm survives the arm — the graph it grew is the one `sent` names', () => {
    const body = `  ${DECLARED}
  ch = write sl-[:Channels]-> { Name: "general" }
  if (e.\`Count\` > 1) {
    one = write ch-[:Messages]-> { Text: "a" }
    link sent -[:messages]-> one
  } else {
    two = write ch-[:Messages]-> { Text: "b" }
    link sent -[:messages]-> two
  }
  sent-[x:messages]-> {
    write x-[:Replies]-> { Text: "done" }
  }`;
    expect(codes(body)).toEqual([]);
  });

  it('rebinding the node is still refused — names never change', () => {
    expect(codes(`  ${DECLARED}\n  ${DECLARED}`)).toContain(C.REBOUND_NAME);
  });

  it('adds nothing to the effect row — run-local mutation is not an effect', () => {
    const row = rowOf(`  ${DECLARED}
  sl-[:Channels]->-[msg:Messages]-> {
    link sent -[:messages]-> msg
  }`);
    expect(row.write).toEqual([]);
    expect(row.partial).toBe(false);
  });
});
