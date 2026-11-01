// An agent authors a customer's movement over MCP, end to end: the SDK's own
// client against `/customers/acme/mcp`, the customer's API key as its bearer
// token. getStarted shows the customer's own fields; a save with a value its
// select does not have is refused (MOV_ENUM_UNKNOWN_VALUE); the fix is an
// edit anchored on the text; the movement then runs on demand, and its run's
// write is in the customer's CRM.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { companyArrived } from '../src/crm';
import { Embedding } from '../src/embedding';
import { fakeModels } from '../src/models';
import { saasServer } from '../src/server';

const LEADS = `import { crm } from adapters
import { workspace } from credentials

app = connect crm using workspace

function file_lead(run: <manual-[:Invocations]->>) {
  write app-[:Company]-> { Name: "\${run.Text}", Stage: "Prospect" }
}

listen to manual-[:Invocations]-> fire file_lead
`;

let server: Server;
let base: string;
let embedding: Embedding;
const clients: Client[] = [];
/** What the embedded host said it did not run. */
const warned: string[] = [];

before(async () => {
  embedding = new Embedding({ models: fakeModels(), log: { warn: (line) => void warned.push(line) } });
  await embedding.addCustomer('acme', 'acme-key', [{ name: 'Stage', options: ['Lead', 'Customer'] }]);
  await embedding.addCustomer('globex', 'globex-key', [{ name: 'Stage', options: ['Prospect', 'Partner'] }]);
  server = saasServer(embedding);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server is not listening on a port');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await Promise.all(clients.map((client) => client.close()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connect(tenant: string, key?: string): Promise<Client> {
  const client = new Client({ name: 'embed-saas-test', version: '0' });
  const headers = key !== undefined ? { authorization: `Bearer ${key}` } : undefined;
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/customers/${tenant}/mcp`), headers !== undefined ? { requestInit: { headers } } : {}));
  clients.push(client);
  return client;
}

/** A tool's answer: its JSON, or its markdown. One line of the session is logged. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map((c: { text?: string }) => c.text ?? '').join('');
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // markdown
  }
  console.log(`mcp ${name} ${JSON.stringify(args).slice(0, 80)} -> ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
  return value;
}

test("a request without the customer's key, or with another customer's, is refused before any tool", async () => {
  await assert.rejects(connect('acme'), /401|bearer/);
  await assert.rejects(connect('acme', 'globex-key'), /401|bearer/);
});

test('an agent builds, fixes and runs a movement over MCP', async () => {
  const agent = await connect('acme', 'acme-key');
  const tools = (await agent.listTools()).tools.map((t) => t.name);
  for (const name of ['getStarted', 'saveAutomation', 'editAutomation', 'runAutomation', 'checkRun']) assert.ok(tools.includes(name), name);

  // The customer's own fields, its select with its own options.
  const started = await call(agent, 'getStarted');
  assert.match(started, /- Company \[rw listenable\]: Name text!, Stage enum\(Lead\|Customer\)/);
  assert.match(started, /### manual — `listen to manual-\[:…\]->`/);

  // The save is the check: a value the select does not have saves nothing.
  const refused = await call(agent, 'saveAutomation', { name: 'File leads', source: LEADS });
  assert.equal(refused.saved, false);
  assert.equal(refused.diagnostics[0].code, 'MOV_ENUM_UNKNOWN_VALUE');
  assert.deepEqual(await call(agent, 'listAutomations'), { automations: [] });

  // Saved with the user's consent, then fixed by an edit anchored on the text.
  const shipped = await call(agent, 'saveAutomation', { name: 'File leads', source: LEADS, acknowledgeErrors: true });
  assert.equal(shipped.saved, true);
  const fixed = await call(agent, 'editAutomation', { idOrName: 'File leads', oldString: 'Stage: "Prospect"', newString: 'Stage: "Lead"', expectedRevision: shipped.revision });
  assert.equal(fixed.saved, true);
  assert.equal(fixed.runnable, true);
  assert.equal(fixed.diagnostics, undefined);

  // Run it on demand, then read its status.
  const ran = await call(agent, 'runAutomation', { automation: fixed.id, text: 'Initech', requestId: 'first' });
  const status = await call(agent, 'checkRun', { runId: ran.runId });
  assert.equal(status.status, 'success');
  assert.equal(status.recordCount, 1);
  assert.equal((await call(agent, 'runAutomation', { automation: fixed.id, text: 'Initech', requestId: 'first' })).runId, ran.runId);
  assert.deepEqual((await call(agent, 'listRuns', { idOrName: 'File leads' })).runs.map((r: { runId: string }) => r.runId), [ran.runId]);
  assert.equal((await call(agent, 'inspectRun', { runId: ran.runId })).writes.length, 1);

  // The write is in this customer's CRM, and the other customer sees none of it.
  const companies = await (await fetch(`${base}/customers/acme/companies`)).json();
  assert.deepEqual(
    companies.map(({ Name, Stage }: Record<string, string>) => ({ Name, Stage })),
    [{ Name: 'Initech', Stage: 'Lead' }],
  );
  const other = await connect('globex', 'globex-key');
  assert.deepEqual(await call(other, 'listAutomations'), { automations: [] });
  assert.deepEqual(await call(other, 'checkRun', { runId: ran.runId }), { error: `run ${ran.runId} not found` });
});

test('a listen the embedded host does not fire as written, saved over MCP all the same, runs nothing when a company arrives, and the host says why', async () => {
  const agent = await connect('globex', 'globex-key');
  const source = `import { crm } from adapters
import { workspace } from credentials

app = connect crm using workspace

function greet(company: <app-[:Company]->>) {
  write app-[:Company]-> { Name: "Hello \${company.Name}" }
}

listen to app fire greet
`;
  const saved = await call(agent, 'saveAutomation', { name: 'Greeter', source, acknowledgeErrors: true });
  assert.equal(saved.saved, true);
  warned.length = 0;

  assert.deepEqual(await embedding.fire('globex', companyArrived({ id: 'c-9', Name: 'Hooli' })), []);
  assert.deepEqual(warned, [
    'Greeter:greet: `listen to app { … }` is in the retired settings form, which this host fires only as a listen on a traversal: write it as one and save it again; until then it runs nothing',
  ]);
});
