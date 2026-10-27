// A small MCP server for tests, over streamable HTTP (stateless: one server
// and transport per request), behind a bearer check. Two kinds, each with two
// tools: one read-only with an output schema, one that changes things and
// answers plain text. Each refuses (`isError`) on one input.
//
//   issues:  search_issues { query, limit? } -> { count, titles[] }
//            create_issue  { title, team, priority? } -> text; title "fail" refused
//   crm:     find_customer { email } -> { name, plan }
//            add_note      { customer, body } -> text; body "fail" refused
//
// The bearer is checked against a fixed token, or (`introspect`) by asking an
// OAuth provider's protected endpoint whether it accepts it.

import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';

export type FakeKind = 'issues' | 'crm';

/** A fault the next matching requests meet before the server reads them. */
export interface Fault {
  /** The JSON-RPC method it hits (any if absent) and, for tools/call, the tool. */
  rpc?: string;
  tool?: string;
  /** How many matching requests it hits; default 1. */
  times?: number;
  /** Answer this status (with the Retry-After, if given)... */
  status?: number;
  retryAfter?: string;
  /** ...or drop the connection without an answer. */
  drop?: true;
}

export interface FakeMcpServer {
  url: string;
  /** Faults to inject, in order; the first that matches a request hits it. */
  faults: Fault[];
  /** Every JSON-RPC request that reached the server, as `method` or `tools/call:<tool>`, faulted ones included. */
  requests: string[];
  /** Every tool call, with the arguments it was sent. */
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** Every request's Authorization (or the configured header's) value. */
  presented: string[];
  /** The issues created, in order. */
  issues: string[];
  close(): Promise<void>;
}

export interface FakeMcpOptions {
  kind: FakeKind;
  /** A fixed token the bearer (or `header`) must carry. */
  token?: string;
  /** Read the token from this header, as written, instead of a bearer. */
  header?: string;
  /** A URL answering 200 for a bearer it accepts (an OAuth provider's protected endpoint). */
  introspect?: string;
}

const TOOLS: Record<FakeKind, Tool[]> = {
  issues: [
    {
      name: 'search_issues',
      description: 'Issues whose title contains the query.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What to look for.' }, limit: { type: 'integer' } }, required: ['query'] },
      outputSchema: { type: 'object', properties: { count: { type: 'integer' }, titles: { type: 'array', items: { type: 'string' } } }, required: ['count', 'titles'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'create_issue',
      description: 'Files an issue.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, team: { type: 'string', enum: ['ENG', 'OPS'] }, priority: { type: 'integer' } },
        required: ['title', 'team'],
      },
    },
  ],
  crm: [
    {
      name: 'find_customer',
      description: 'The customer with this email.',
      inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
      outputSchema: { type: 'object', properties: { name: { type: 'string' }, plan: { type: 'string' } }, required: ['name', 'plan'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'add_note',
      description: 'Adds a note to a customer.',
      inputSchema: { type: 'object', properties: { customer: { type: 'string' }, body: { type: 'string' } }, required: ['customer', 'body'] },
      annotations: { destructiveHint: false },
    },
  ],
};

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function answer(fake: FakeMcpServer, kind: FakeKind, tool: string, args: Record<string, unknown>): CallToolResult {
  const s = (key: string): string => String(args[key] ?? '');
  switch (`${kind}.${tool}`) {
    case 'issues.search_issues': {
      const titles = fake.issues.filter((t) => t.includes(s('query'))).slice(0, typeof args.limit === 'number' ? args.limit : undefined);
      const structured = { count: titles.length, titles };
      return { content: [{ type: 'text', text: `${titles.length} issue(s)` }], structuredContent: structured };
    }
    case 'issues.create_issue':
      if (s('title') === 'fail') return text(`team ${s('team')} does not take issues titled "fail"`, true);
      fake.issues.push(s('title'));
      return text(`created ${s('team')}-${fake.issues.length}: ${s('title')}`);
    case 'crm.find_customer':
      return { content: [{ type: 'text', text: `found ${s('email')}` }], structuredContent: { name: s('email').split('@')[0] ?? '', plan: 'pro' } };
    case 'crm.add_note':
      if (s('body') === 'fail') return text(`notes for ${s('customer')} are closed`, true);
      return text(`noted on ${s('customer')}`);
    default:
      return text(`no tool ${tool}`, true);
  }
}

function mcpServer(fake: FakeMcpServer, kind: FakeKind): Server {
  const server = new Server({ name: `fake-${kind}`, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS[kind] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    fake.calls.push({ tool: request.params.name, args });
    return answer(fake, kind, request.params.name, args);
  });
  return server;
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw === '' ? undefined : JSON.parse(raw);
}

async function accepted(options: FakeMcpOptions, presented: string): Promise<boolean> {
  if (options.introspect !== undefined) {
    const answer = await fetch(options.introspect, { headers: { authorization: presented } });
    return answer.ok;
  }
  const expected = options.header === undefined ? `Bearer ${options.token}` : options.token;
  return presented === expected;
}

export async function startFakeMcpServer(options: FakeMcpOptions): Promise<FakeMcpServer> {
  let http: HttpServer | undefined;
  const fake: FakeMcpServer = {
    url: '',
    faults: [],
    requests: [],
    calls: [],
    presented: [],
    issues: ['Login page is slow'],
    close: () =>
      new Promise((done) => {
        if (http === undefined) return done();
        http.close(() => done());
        http.closeAllConnections();
      }),
  };
  http = createServer((req, res) => {
    void (async () => {
      const presented = String(req.headers[(options.header ?? 'authorization').toLowerCase()] ?? '');
      fake.presented.push(presented);
      if (!(await accepted(options, presented))) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
      const body = await bodyOf(req);
      const rpc = typeof body === 'object' && body !== null ? (body as { method?: string; params?: { name?: string } }) : {};
      fake.requests.push(rpc.method === 'tools/call' ? `tools/call:${rpc.params?.name}` : String(rpc.method));
      const fault = fake.faults.find((f) => (f.rpc === undefined || f.rpc === rpc.method) && (f.tool === undefined || f.tool === rpc.params?.name));
      if (fault !== undefined) {
        fault.times = (fault.times ?? 1) - 1;
        if (fault.times <= 0) fake.faults.splice(fake.faults.indexOf(fault), 1);
        if (fault.drop) return void req.socket.destroy();
        res.writeHead(fault.status ?? 500, { 'content-type': 'text/plain', ...(fault.retryAfter === undefined ? {} : { 'retry-after': fault.retryAfter }) });
        return void res.end(`fault ${fault.status ?? 500}`);
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const server = mcpServer(fake, options.kind);
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((done) => http!.listen(0, '127.0.0.1', done));
  fake.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  return fake;
}
