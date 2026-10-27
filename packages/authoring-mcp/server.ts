// The authoring tools over MCP: one HTTP request handler, streamable HTTP,
// no sessions. Each request is its own server: the host's tenant function
// runs first, and a request it refuses is answered before any tool exists.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { LANGUAGE_VERSION } from 'movement-lang';

import type { AuthoringHost, TenantHost } from './host';
import { AUTHORING_TOOL_NAMES, RUN_TOOL_NAMES, authoringInstructions, registerAuthoringTools, toolResult } from './tools';

export interface AuthoringHandlerOptions {
  /** The server's name, as a client shows it. Default `listen-fire-authoring`. */
  name?: string;
  /** The server's version. Default the language version it checks against. */
  version?: string;
}

/** The handler's shape: node's request and response, and the body when the
 *  host's framework has already parsed it. */
export type AuthoringHandler = (request: IncomingMessage, response: ServerResponse, parsedBody?: unknown) => Promise<void>;

const SERVED: ReadonlySet<string> = new Set([...AUTHORING_TOOL_NAMES, ...RUN_TOOL_NAMES]);

/**
 * The HTTP handler that serves the authoring tools for `host`. The host
 * mounts it at a path of its choosing (POST, GET and DELETE), behind its own
 * auth, which its `tenant` function applies to every request.
 */
export function createAuthoringHandler<T extends TenantHost>(host: AuthoringHost<T>, options: AuthoringHandlerOptions = {}): AuthoringHandler {
  for (const name of Object.keys(host.tools ?? {})) {
    if (SERVED.has(name)) throw new Error(`the host's tool "${name}" has the name of one this package serves`);
  }
  return async (request, response, parsedBody) => {
    const access = await host.tenant(request);
    if (!access.ok) {
      response.writeHead(access.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: access.message }, id: null }));
      return;
    }
    const server = authoringServer(host, access.tenant, options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, parsedBody);
  };
}

/** The MCP server for one tenant's request: the package's tools (the run
 *  tools only when the tenant has runs), then the host's own. */
export function authoringServer<T extends TenantHost>(host: AuthoringHost<T>, tenant: T, options: AuthoringHandlerOptions = {}): McpServer {
  const server = new McpServer(
    { name: options.name ?? 'listen-fire-authoring', version: options.version ?? LANGUAGE_VERSION },
    { instructions: authoringInstructions({ runs: tenant.runs !== undefined, ...(host.instructions !== undefined ? { extra: host.instructions } : {}) }) },
  );
  registerAuthoringTools(server, { tenant, chapters: host.chapters ?? {} });
  for (const [name, tool] of Object.entries(host.tools ?? {})) {
    server.registerTool(
      name,
      { title: tool.title, description: tool.description, annotations: tool.annotations, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => toolResult(await tool.handler(args, tenant)),
    );
  }
  return server;
}
