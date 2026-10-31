// One position for the message type, reached along `Messages`: the edge a
// walk reads and the edge a listen hears are one edge, so a record walked off
// `mail-[m:Messages]->` and a record a listen on it delivers are the same
// type, and passing one into a parameter typed against the other typechecks
// as any same-typed value does. The type-marker grammar (`<inst-[:X]->>`)
// reads a single hop as the position its records have, by the position's
// name or by a collection's target, so `<mail-[:Messages]->>` and
// `<mail-[:Message]->>` are the same type; a name that is neither is refused
// with MOV_UNKNOWN_POSITION. `Labelings` lands on a position of its own.

import { LANGUAGE_VERSION, checkSourceInRust, mockCatalogSnapshot, type Diagnostic } from 'movement-lang';

import { instanceSchemaFromDescriptors } from 'movement-engine/public/catalog';
import { gmailEntryPoints, GMAIL_MAILBOX_DESCRIPTOR, describeGmailType } from '../schema';
import { GMAIL_MESSAGE_TYPE_ID, GMAIL_ATTACHMENT_TYPE_ID, GMAIL_LABELING_TYPE_ID } from '../types';

const descriptors = new Map(
  [GMAIL_MESSAGE_TYPE_ID, GMAIL_ATTACHMENT_TYPE_ID, GMAIL_LABELING_TYPE_ID].map((typeId) => [
    typeId,
    describeGmailType(typeId)!,
  ]),
);

const { schema: gmailSchema, notes } = instanceSchemaFromDescriptors({
  adapterType: 'gmail',
  entries: gmailEntryPoints(),
  descriptors,
  metaDescriptor: GMAIL_MAILBOX_DESCRIPTOR,
  supportsInPlaceUpdate: false,
});

const catalog = mockCatalogSnapshot({
  adapters: {
    gmail: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: gmailSchema,
    },
  },
  credentials: { gmail_cred: { adapter: 'gmail' } },
});

const PRELUDE = `import { gmail } from adapters
import { gmail_cred } from credentials
mail = connect gmail using gmail_cred
`;

function errors(source: string): Diagnostic[] {
  return checkSourceInRust(source, catalog, { languageVersion: LANGUAGE_VERSION }).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}

describe('the real Gmail projection: one position for the message type', () => {
  it('mints one position per type, keyed by displayName ("Message"), no note', () => {
    expect(Object.keys(gmailSchema.positions).sort()).toEqual(['Attachment', 'Draft', 'Labeling', 'Message']);
    expect(notes).toEqual([]);
  });

  it('the Messages collection targets that position, and a listen hears it there', () => {
    expect(gmailSchema.collections.Messages).toMatchObject({ target: 'Message', listenable: true, delivery: 'polled' });
  });

  it('a label being added lands on its own position, never read as a list', () => {
    expect(gmailSchema.collections.Labelings).toMatchObject({ target: 'Labeling', listenable: true, readable: false });
  });
});

describe('<mail-[:Messages]->> is the collection edge onto the one position; a name that is neither is refused', () => {
  it('a parameter typed along the collection edge is the Message position and reads its fields', () => {
    const source = `${PRELUDE}
function Triage(m: <mail-[:Messages]->>) {
  x = m.\`Subject\`
}
`;
    expect(errors(source)).toEqual([]);
  });

  it('a name that is no position and no collection is refused, naming the real positions', () => {
    const source = `${PRELUDE}
function Triage(m: <mail-[:Messagez]->>) {
  x = m.\`Subject\`
}
`;
    const message = errors(source).find((d) => d.code === 'MOV_UNKNOWN_POSITION')?.message;
    expect(message).toContain("has no position type 'Messagez'");
    expect(message).toContain('Message');
  });
});

describe('a record from either edge satisfies a parameter typed against the other — because they are the same position', () => {
  it('a record walked off the Messages collection passes into a function typed <mail-[:Message]->>', () => {
    const source = `${PRELUDE}
function Triage(m: <mail-[:Message]->>) {
  x = m.\`Subject\`
}
function lister(go: <mail-[:Message]->>) {
  found = mail-[m:Messages]-> { return m }
  Triage(found[0])
}
`;
    expect(errors(source)).toEqual([]);
  });

  it("a listen's own record passes straight through to the same parameter", () => {
    const source = `${PRELUDE}
function Triage(m: <mail-[:Message]->>) {
  x = m.\`Subject\`
}
function main(msg: <mail-[:Messages]->>) {
  Triage(msg)
}
listen to mail-[m:Messages WHERE m.Labels CONTAINS "INBOX"]-> fire main
`;
    expect(errors(source)).toEqual([]);
  });
});
