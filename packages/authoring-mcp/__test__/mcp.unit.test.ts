// The tools over MCP, end to end: the SDK's own client against the handler
// over HTTP, the in-memory host behind it. A request the host refuses sees no
// tools; a tenant without runs is not offered the run tools; a save is
// refused with its diagnostics, fixed by an anchored edit under the revision
// read, and run.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import { AUTHORING_TOOL_NAMES, RUN_TOOL_NAMES, createAuthoringHandler } from '..';
import { memoryAuthoringHost, memoryTenantHost, scriptedRuns } from '../testing';
import { CATALOG, fileAs } from './fixtures';

const acmeRuns = scriptedRuns(({ text }) => ({
  status: 'success',
  recordCount: 1,
  event: { text: text ?? '' },
  writes: [{ Company: { Name: text ?? '', Stage: 'Lead' } }],
  decisions: [],
  errors: [],
}));
const acme = memoryTenantHost({ catalog: CATALOG, runs: acmeRuns });
const globex = memoryTenantHost({ catalog: CATALOG });

const host = memoryAuthoringHost({
  tenants: { 'acme-key': acme, 'globex-key': globex },
  instructions: 'This host is a test.',
  tools: {
    whoAmI: {
      title: 'Who am I',
      description: 'The tenant this connection acts for.',
      annotations: { readOnlyHint: true },
      inputSchema: { shout: z.boolean().optional() },
      handler: async (args, tenant) => ({ json: { acme: tenant === acme, shout: args.shout === true } }),
    },
  },
});

let server: Server;
let url: URL;

beforeAll(async () => {
  const handler = createAuthoringHandler(host);
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});

const clients: Client[] = [];

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  server.closeAllConnections();
  await new Promise((closed) => server.close(closed));
});

async function connect(token?: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(url, token !== undefined ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {});
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** A tool's answer, as the JSON its text carries. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; value: any }> {
  const result = await client.callTool({ name, arguments: args });
  const content = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(result.content);
  const text = content.map((c) => c.text).join('');
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // markdown
  }
  return { isError: result.isError === true, value };
}

describe('the authoring tools over MCP', () => {
  it('answers a request the host refuses before any tool is listed', async () => {
    await expect(connect()).rejects.toThrow(/401|no tenant/);
    await expect(connect('wrong-key')).rejects.toThrow(/401|no tenant/);
  });

  it('lists the run tools only for a tenant whose host runs them, and the host tools beside its own', async () => {
    const withRuns = await connect('acme-key');
    const names = (await withRuns.listTools()).tools.map((t) => t.name);
    expect(names).toEqual([...AUTHORING_TOOL_NAMES, ...RUN_TOOL_NAMES, 'whoAmI']);
    expect(withRuns.getInstructions()).toMatch(/Call getStarted first[\s\S]*runAutomation[\s\S]*This host is a test\./);
    expect((await call(withRuns, 'whoAmI', { shout: true })).value).toEqual({ acme: true, shout: true });

    const without = await connect('globex-key');
    expect((await without.listTools()).tools.map((t) => t.name)).toEqual([...AUTHORING_TOOL_NAMES, 'whoAmI']);
    expect(without.getInstructions()).not.toMatch(/runAutomation/);
    expect((await call(without, 'whoAmI')).value).toEqual({ acme: false, shout: false });
  });

  it('builds an automation: getStarted, a refused save, an anchored fix, a run and its status', async () => {
    const client = await connect('acme-key');

    const started = await call(client, 'getStarted');
    expect(started.value).toContain('- Company [rw fires]: Name text!, Stage enum(Lead|Customer)');
    expect(started.value).toContain('it is TypeScript, except');

    // The save is the check: nothing is saved while it has errors.
    const refused = await call(client, 'saveAutomation', { name: 'File leads', source: fileAs('Prospect') });
    expect(refused.value).toMatchObject({ ok: false, saved: false, diagnostics: [{ code: 'MOV_ENUM_UNKNOWN_VALUE', line: 7 }] });
    expect((await call(client, 'listAutomations')).value).toEqual({ automations: [] });

    // Saved with consent, broken; then fixed by an edit anchored on the text.
    const shipped = await call(client, 'saveAutomation', { name: 'File leads', source: fileAs('Prospect'), acknowledgeErrors: true });
    expect(shipped.value).toMatchObject({ ok: true, saved: true, runnable: true, listeners: [{ system: 'manual', movement: 'file_lead' }] });
    const { id, revision } = shipped.value;

    const stale = await call(client, 'editAutomation', { idOrName: 'File leads', oldString: '"Prospect"', newString: '"Lead"', expectedRevision: 'not-it' });
    expect(stale.value).toMatchObject({ ok: false, saved: false, conflict: true, current: { revision } });

    const ambiguous = await call(client, 'editAutomation', { idOrName: id, oldString: 'app', newString: 'crm_app', expectedRevision: revision });
    expect(ambiguous).toMatchObject({ isError: true, value: { error: expect.stringMatching(/matches \d+ places/) } });

    const stillBroken = await call(client, 'editAutomation', { idOrName: id, oldString: '"Prospect"', newString: '"Partner"', expectedRevision: revision });
    expect(stillBroken.value).toMatchObject({ ok: false, saved: false, diagnostics: [{ code: 'MOV_ENUM_UNKNOWN_VALUE' }] });

    const fixed = await call(client, 'editAutomation', { idOrName: id, oldString: '"Prospect"', newString: '"Lead"', expectedRevision: revision });
    expect(fixed.value).toMatchObject({ ok: true, saved: true, id, name: 'File leads' });
    expect(fixed.value.revision).not.toBe(revision);

    const read = await call(client, 'readAutomation', { idOrName: 'File leads', offset: 7, limit: 1 });
    expect(read.value).toMatchObject({ revision: fixed.value.revision, lines: [{ n: 7, text: expect.stringContaining('Stage: "Lead"') }] });
    expect((await call(client, 'grepAutomations', { pattern: 'Stage' })).value).toMatchObject({ matches: [{ id, line: 7 }], truncated: false });
    expect((await call(client, 'validateAutomation', { source: acme.programs.saved.get(id)?.source })).value).toMatchObject({ ok: true, diagnostics: [] });

    // A run, by name, and a retry with the same request id gets the same run.
    const ran = await call(client, 'runAutomation', { automation: 'File leads', text: 'Initech', requestId: 'r1' });
    expect(ran.value).toMatchObject({ runId: 'run-1', status: 'success', automation: 'File leads' });
    expect((await call(client, 'runAutomation', { automation: id, text: 'Initech', requestId: 'r1' })).value).toMatchObject({ runId: 'run-1' });
    expect((await call(client, 'checkRun', { runId: 'run-1' })).value).toEqual({ runId: 'run-1', status: 'success', recordCount: 1 });
    expect((await call(client, 'listRuns', { idOrName: id })).value).toEqual({ runs: [{ runId: 'run-1', status: 'success', recordCount: 1 }] });
    expect((await call(client, 'inspectRun', { runId: 'run-1' })).value).toMatchObject({ writes: [{ Company: { Name: 'Initech' } }] });
    expect(await call(client, 'checkRun', { runId: 'run-9' })).toMatchObject({ isError: true });

    // Another tenant does not see it.
    const other = await connect('globex-key');
    expect((await call(other, 'getAutomation', { idOrName: id })).value).toEqual({ error: `No automation '${id}'.` });

    expect((await call(client, 'deleteAutomation', { automation: id })).value).toEqual({ deleted: true, automation: id });
    expect((await call(client, 'deleteAutomation', { automation: id })).value).toEqual({ deleted: false, automation: id });
  });

  it('serves the language tools: the handbook, its search, the connections and a describe', async () => {
    const client = await connect('globex-key');
    expect((await call(client, 'readHandbook', { chapter: 'front#maybe-absent' })).value).toMatchObject({ chapter: 'front', section: 'maybe-absent' });
    expect((await call(client, 'searchLanguage', { query: 'join text' })).value.results.length).toBeGreaterThan(0);
    expect((await call(client, 'listConnections')).value).toMatchObject({
      connections: [{ name: 'workspace', system: 'crm' }],
      systems: expect.arrayContaining([expect.objectContaining({ system: 'mail', connected: false })]),
    });
    expect((await call(client, 'describeConnection', { system: 'crm', position: '-[:Company]->' })).value).toContain('Company [rw fires]');
    expect((await call(client, 'describeConnection', { system: ['crm', 'manual'] })).value).toMatch(/### crm[\s\S]*### manual/);
    expect((await call(client, 'describeConnection', { system: 'crm', detail: 'full' })).value).toMatchObject({ system: 'crm', schema: { collections: { Company: {} } } });
  });

  it('refuses a host tool named like one of its own', () => {
    expect(() =>
      createAuthoringHandler(memoryAuthoringHost({ tenants: {}, tools: { getStarted: { title: 't', description: 'd', annotations: {}, inputSchema: {}, handler: async () => ({ text: '' }) } } })),
    ).toThrow(/has the name of one this package serves/);
  });
});
