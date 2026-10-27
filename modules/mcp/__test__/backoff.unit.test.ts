// A connection to a flaky server: 429 and 5xx and network errors are retried
// with backoff, Retry-After is honoured, and a tool call that changes things
// is sent again only when it clearly never reached the server. Waits are
// recorded, not slept.

import { McpConnection, TOKEN_CREDENTIAL, addressOf, type RetryNote } from '../client';
import { startFakeMcpServer, type FakeMcpServer } from './fake_server';

describe('an MCP connection to a flaky server', () => {
  let fake: FakeMcpServer;
  beforeAll(async () => {
    fake = await startFakeMcpServer({ kind: 'issues', token: 't0k' });
  });
  afterAll(() => fake.close());
  beforeEach(() => {
    fake.faults.length = 0;
    fake.requests.length = 0;
    fake.calls.length = 0;
  });

  const waits: number[] = [];
  const notes: RetryNote[] = [];
  beforeEach(() => {
    waits.length = 0;
    notes.length = 0;
  });
  const connection = (token = 't0k', url = fake.url): McpConnection =>
    new McpConnection(addressOf(TOKEN_CREDENTIAL, { url, token }), fetch, {
      retry: { sleep: async (ms) => void waits.push(ms), random: () => 1, baseDelayMs: 100 },
      onRetry: (note) => notes.push(note),
    });
  const sent = (rpc: string): number => fake.requests.filter((r) => r === rpc).length;

  it('retries a 503 on tools/list and answers', async () => {
    fake.faults.push({ rpc: 'tools/list', status: 503 });
    const tools = await connection().listTools();
    expect(tools.map((t) => t.name)).toEqual(['search_issues', 'create_issue']);
    expect(sent('tools/list')).toBe(2);
    expect(waits).toEqual([100]);
  });

  it('retries a 503 on initialize', async () => {
    fake.faults.push({ rpc: 'initialize', status: 503 });
    await connection().listTools();
    expect(sent('initialize')).toBe(2);
  });

  it('honours a 429 Retry-After in seconds, on a tool that changes things', async () => {
    fake.faults.push({ rpc: 'tools/call', tool: 'create_issue', status: 429, retryAfter: '2' });
    const connected = connection();
    await connected.listTools();
    const result = await connected.call('create_issue', { title: 'Retried', team: 'ENG' });
    expect(JSON.stringify(result.content)).toContain('created ENG-');
    expect(waits).toEqual([2000]);
    expect(fake.calls.filter((c) => c.tool === 'create_issue')).toHaveLength(1);
  });

  it('retries a 503 with Retry-After on a tool that changes things', async () => {
    fake.faults.push({ rpc: 'tools/call', tool: 'create_issue', status: 503, retryAfter: '1' });
    const connected = connection();
    await connected.listTools();
    await connected.call('create_issue', { title: 'After a 503', team: 'OPS' });
    expect(waits).toEqual([1000]);
  });

  it('does not retry a 500 on a tool that changes things: it may have changed them', async () => {
    fake.faults.push({ rpc: 'tools/call', tool: 'create_issue', status: 500 });
    const connected = connection();
    await connected.listTools();
    await expect(connected.call('create_issue', { title: 'Maybe', team: 'ENG' })).rejects.toThrow(/500/);
    expect(sent('tools/call:create_issue')).toBe(1);
    expect(waits).toEqual([]);
  });

  it('does not retry a bare 503 (no Retry-After) on a tool that changes things', async () => {
    fake.faults.push({ rpc: 'tools/call', tool: 'create_issue', status: 503 });
    const connected = connection();
    await connected.listTools();
    await expect(connected.call('create_issue', { title: 'Maybe', team: 'ENG' })).rejects.toThrow(/503/);
    expect(sent('tools/call:create_issue')).toBe(1);
  });

  it('retries a 500 on a read-only tool', async () => {
    fake.faults.push({ rpc: 'tools/call', tool: 'search_issues', status: 500 });
    const connected = connection();
    await connected.listTools();
    const result = await connected.call('search_issues', { query: 'slow' });
    expect(result.structuredContent).toMatchObject({ count: 1 });
    expect(sent('tools/call:search_issues')).toBe(2);
  });

  it('retries a dropped connection on a read-only tool, not on a tool that changes things', async () => {
    const connected = connection();
    await connected.listTools();
    fake.faults.push({ rpc: 'tools/call', tool: 'search_issues', drop: true });
    await connected.call('search_issues', { query: 'slow' });
    expect(sent('tools/call:search_issues')).toBe(2);

    fake.faults.push({ rpc: 'tools/call', tool: 'create_issue', drop: true });
    await expect(connected.call('create_issue', { title: 'Unknown', team: 'ENG' })).rejects.toThrow(/MCP server/);
    expect(sent('tools/call:create_issue')).toBe(1);
  });

  it('retries a refused connection on a tool that changes things: nothing reached the server', async () => {
    const closed = await startFakeMcpServer({ kind: 'issues', token: 't0k' });
    const url = closed.url;
    await closed.close();
    const error = await connection('t0k', url).call('create_issue', { title: 'x', team: 'ENG' }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/ECONNREFUSED.* after 4 attempts/);
  });

  it('gives up after four attempts, saying the status, the attempts and the wait', async () => {
    fake.faults.push({ rpc: 'tools/list', status: 502, times: 10 });
    const error = await connection().listTools().catch((e: unknown) => e);
    expect((error as Error).message).toBe(`MCP server ${fake.url}: HTTP 502 after 4 attempts (waited 0.7s): fault 502`);
    expect(sent('tools/list')).toBe(4);
    expect(waits).toEqual([100, 200, 400]);
  });

  it('does not wait past its budget for a long Retry-After', async () => {
    fake.faults.push({ rpc: 'tools/list', status: 429, retryAfter: '90', times: 5 });
    const error = await connection().listTools().catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/HTTP 429 \(the server asked to wait 90s, over the retry budget of 20s\)/);
    expect(waits).toEqual([]);
    expect(sent('tools/list')).toBe(1);
  });

  it('does not retry a refused credential: it fails at once, naming the credential', async () => {
    const error = await connection('wrong').listTools().catch((e: unknown) => e);
    expect((error as Error).message).toBe(`MCP server ${fake.url} refused the credential (HTTP 401).`);
    expect(waits).toEqual([]);
  });

  it('does not retry a 404, 400 or 422', async () => {
    for (const status of [400, 404, 422]) {
      fake.requests.length = 0;
      fake.faults.push({ rpc: 'tools/list', status });
      await expect(connection().listTools()).rejects.toThrow(String(status));
      expect(sent('tools/list')).toBe(1);
    }
  });

  it('notes each retry, with what it retried and how long it waited', async () => {
    fake.faults.push({ rpc: 'tools/list', status: 503 }, { rpc: 'tools/list', status: 429, retryAfter: '3' });
    await connection().listTools();
    expect(notes).toEqual([
      { attempt: 1, of: 4, waitMs: 100, because: 'HTTP 503' },
      { attempt: 2, of: 4, waitMs: 3000, because: 'HTTP 429' },
    ]);
  });
});
