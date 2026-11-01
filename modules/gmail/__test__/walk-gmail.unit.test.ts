// A walk of `Messages`: the mailbox's search reads a label by its name, and
// the message it hands back names its labels the same way, so the engine's
// own check of `m.Labels CONTAINS "Deals"` over what came back agrees.

import type { Expression } from 'engine-contracts/expression/expression';
import { makeMetaPosition } from 'movement-engine/public/catalog';

import type { GmailApiClient, GmailMessage } from '../api_client';
import { adapterOver } from './host';

const LABELS = [
  { id: 'INBOX', name: 'INBOX' },
  { id: 'Label_deals', name: 'Deals' },
  { id: 'Label_other', name: 'Other' },
];

function wire(id: string, labelIds: string[]): GmailMessage {
  return {
    id,
    threadId: `t-${id}`,
    labelIds,
    snippet: id,
    internalDate: String(Date.UTC(2026, 8, 22, 9, 30)),
    payload: { mimeType: 'text/plain', filename: '', headers: [{ name: 'Subject', value: `About ${id}` }], body: { size: 1, data: Buffer.from('hi').toString('base64url') } },
  };
}

/** A mailbox whose search takes `label:<name>` the way Gmail does. */
function mailbox(messages: GmailMessage[]) {
  const searched: (string | undefined)[] = [];
  const client = {
    credentials: { mailbox: 'nemo@example.com', method: 'oauth' },
    async listLabels() {
      return LABELS;
    },
    async listMessages(input: { query?: string }) {
      searched.push(input.query);
      const wanted = /^label:(\S+)$/.exec(input.query ?? '')?.[1];
      const id = LABELS.find((label) => label.name === wanted)?.id;
      return { messages: messages.filter((m) => id === undefined || m.labelIds?.includes(id)).map((m) => ({ id: m.id })) };
    },
    async getMessage(id: string) {
      const found = messages.find((m) => m.id === id);
      if (found === undefined) throw new Error(`no message ${id}`);
      return found;
    },
  } as unknown as GmailApiClient;
  return { client, searched };
}

const labelsContain = (name: string): Expression =>
  ({ type: 'compare', op: 'contains', left: { type: 'edge_property', propertyTypeId: 'Labels' }, right: { type: 'static', value: name } }) as Expression;

describe('a walk of Messages names labels the way its search and the program do', () => {
  const messages = [wire('deal', ['INBOX', 'Label_deals']), wire('plain', ['INBOX']), wire('other', ['Label_other'])];

  it('filtering by a user label name returns its messages, reading Labels gives names', async () => {
    const { client, searched } = mailbox(messages);
    const adapter = adapterOver(client);
    const found = await adapter.getRelated({ position: makeMetaPosition('gmail'), fieldId: 'Messages', direction: 'outgoing', where: labelsContain('Deals') });

    expect(searched).toEqual(['label:Deals']);
    expect(await Promise.all(found.map((r) => adapter.getFieldValue({ position: r.position, fieldId: 'Subject' })))).toEqual(['About deal']);
    expect(await adapter.getFieldValue({ position: found[0]!.position, fieldId: 'Labels' })).toEqual(['INBOX', 'Deals']);
  });

  it('keeps a system label as Gmail names it and asks for the label list only when a user label is there', async () => {
    const { client } = mailbox([wire('plain', ['INBOX', 'UNREAD'])]);
    const listed = jest.spyOn(client, 'listLabels');
    const adapter = adapterOver(client);
    const found = await adapter.getRelated({ position: makeMetaPosition('gmail'), fieldId: 'Messages', direction: 'outgoing' });

    expect(await Promise.all(found.map((r) => adapter.getFieldValue({ position: r.position, fieldId: 'Labels' })))).toEqual([['INBOX', 'UNREAD']]);
    expect(listed).not.toHaveBeenCalled();
  });

  it('reads one message back by id with its labels by name', async () => {
    const { client } = mailbox(messages);
    const record = await adapterOver(client).readRecord({ recordType: 'Message', externalId: 'deal' } as never);
    expect(record?.['labels']).toEqual(['INBOX', 'Deals']);
  });
});
