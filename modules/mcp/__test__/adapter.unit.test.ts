// The adapter over the SDK against the fake server: the tool list as types, a
// write as a call, a read with its WHERE's pins as arguments, a refused call,
// a refused credential, and a token sent under a header the credential names.

import { META_RECORD_TYPE, makeStablePosition } from 'engine-contracts';
import type { Expression } from 'engine-contracts/expression/expression';

import { McpAdapter } from '../adapter';
import { TOKEN_CREDENTIAL, addressOf, closeConnections, connectionFor } from '../client';
import { startFakeMcpServer, type FakeMcpServer } from './fake_server';

const ROOT = makeStablePosition({ adapterType: 'mcp', recordType: META_RECORD_TYPE, recordId: 'root', data: {} });

function adapterFor(fields: Record<string, string>): McpAdapter {
  return new McpAdapter(async () => connectionFor(addressOf(TOKEN_CREDENTIAL, fields)));
}

describe('the MCP adapter against a fake server', () => {
  let fake: FakeMcpServer;
  beforeAll(async () => {
    fake = await startFakeMcpServer({ kind: 'issues', token: 't0k' });
  });
  afterAll(async () => {
    closeConnections();
    await fake.close();
  });

  const adapter = (): McpAdapter => adapterFor({ url: fake.url, token: 't0k' });

  it('lists the tools as types, writes and reads', async () => {
    expect(await adapter().listEntryPoints()).toEqual([
      { typeId: 'search_issues', displayName: 'search_issues', writable: false, readable: true, description: 'Issues whose title contains the query.' },
      { typeId: 'create_issue', displayName: 'create_issue', writable: true, readable: false, description: 'Files an issue.' },
    ]);
    const create = await adapter().describe('create_issue');
    expect(create?.fields.map((f) => `${f.fieldId}:${f.kind}${f.required ? '!' : ''}`)).toEqual(['title:string!', 'team:enum!', 'priority:number', 'text:string', 'content:json']);
    expect(await adapter().describe('nothing')).toBeNull();
  });

  it('writes: one call with the fields, its text read back', async () => {
    const written = await adapter().createRecord({ recordType: 'create_issue', fields: { title: 'Export breaks', team: 'ENG', priority: null } } as never);
    expect(written.data).toMatchObject({ text: 'created ENG-2: Export breaks' });
    expect(fake.calls.at(-1)).toEqual({ tool: 'create_issue', args: { title: 'Export breaks', team: 'ENG' } });
  });

  it('reads: the WHERE pins are the arguments, copied onto the one record answered', async () => {
    const where: Expression = { type: 'compare', op: 'eq', left: { type: 'edge_property', propertyTypeId: 'query' }, right: { type: 'static', value: 'slow' } };
    const [record, ...rest] = await adapter().getRelated({ position: ROOT, fieldId: 'search_issues', direction: 'outgoing', where } as never);
    expect(rest).toEqual([]);
    expect(record?.position.identity).toMatchObject({ data: { query: 'slow', count: 1, titles: ['Login page is slow'], text: '1 issue(s)' } });
  });

  it('refuses a read missing a required argument, naming it', async () => {
    await expect(adapter().getRelated({ position: ROOT, fieldId: 'search_issues', direction: 'outgoing' } as never)).rejects.toThrow(
      'search_issues needs "query": pin it in the read\'s WHERE with ==',
    );
  });

  it('fails a refused call with the server’s text', async () => {
    await expect(adapter().createRecord({ recordType: 'create_issue', fields: { title: 'fail', team: 'OPS' } } as never)).rejects.toThrow(
      'create_issue: team OPS does not take issues titled "fail"',
    );
  });

  it('says the server refused the credential', async () => {
    await expect(adapterFor({ url: fake.url, token: 'wrong' }).listEntryPoints()).rejects.toThrow(`MCP server ${fake.url} refused the credential (HTTP 401).`);
  });

  it('sends the token under the header the credential names', async () => {
    const keyed = await startFakeMcpServer({ kind: 'crm', token: 'k3y', header: 'X-Api-Key' });
    try {
      const types = await adapterFor({ url: keyed.url, token: 'k3y', header: 'X-Api-Key' }).listEntryPoints();
      expect(types.map((t) => t.typeId)).toEqual(['find_customer', 'add_note']);
      expect(keyed.presented.every((p) => p === 'k3y')).toBe(true);
    } finally {
      await keyed.close();
    }
  });

  it('refuses a credential with no server url, or one not over http', () => {
    expect(() => addressOf(TOKEN_CREDENTIAL, { token: 'x' })).toThrow('MCP: the credential holds no server url');
    expect(() => addressOf(TOKEN_CREDENTIAL, { url: 'stdio:./server', token: 'x' })).toThrow('over streamable HTTP only');
  });
});
