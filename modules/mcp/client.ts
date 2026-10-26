// One MCP server, reached as one connection: the server's URL and how to sign
// in come from the connection's credential, never from the install, so two
// connections of this module reach two servers. Streamable HTTP only: a
// connection never starts a local process.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CredentialFields } from 'module-kit';

import type { McpCallResult, McpTool } from './tools';

/** The two credentials a connection may name. */
export const OAUTH_CREDENTIAL = 'mcp';
export const TOKEN_CREDENTIAL = 'mcp_token';

/** Where a connection reaches its server, and the header it signs in with. */
export interface ServerAddress {
  url: string;
  header: { name: string; value: string };
}

/** The server and sign-in a credential holds: a token credential's `token`,
 *  sent as `Authorization: Bearer <token>` or, with `header`, as that header
 *  holding the token as written; an OAuth one's access token, as a bearer. */
export function addressOf(credential: string, fields: CredentialFields): ServerAddress {
  const url = fields.url?.trim() ?? '';
  if (url === '') throw new Error(`MCP: the credential holds no server url. Add it: lf credential update <name>.`);
  if (!/^https?:\/\//.test(url)) throw new Error(`MCP: the server url "${url}" is not an http(s) URL; a connection reaches its server over streamable HTTP only.`);
  if (credential === TOKEN_CREDENTIAL) {
    const token = fields.token ?? '';
    if (token === '') throw new Error('MCP: the credential holds no token.');
    const header = fields.header?.trim() ?? '';
    return { url, header: header === '' ? { name: 'authorization', value: `Bearer ${token}` } : { name: header, value: token } };
  }
  const token = fields.access_token ?? '';
  if (token === '') throw new Error('MCP: the credential holds no access token. Sign in again: lf credential update <name>.');
  return { url, header: { name: 'authorization', value: `Bearer ${token}` } };
}

/** What a failed exchange with the server says, the server's own words kept. */
function failure(address: ServerAddress, error: unknown): Error {
  if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
    return new Error(`MCP server ${address.url} refused the credential (HTTP ${error.code}).`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`MCP server ${address.url}: ${message}`);
}

/** The tools each server last listed, by server and sign-in: a describe lists
 *  them afresh, and the calls after it read them from here. */
const listed = new Map<string, McpTool[]>();
/** Servers whose tool lists are kept at once; the oldest is forgotten past it. */
const KEPT = 64;

function keyOf(address: ServerAddress): string {
  return JSON.stringify([address.url, address.header.name, address.header.value]);
}

/**
 * One adapter call's reach to its server, through the host's fetch for that
 * call (`ctx.fetch`: the limiter's door under lf, the host's own client in
 * process). A session lives for the one exchange it opens for: the host's
 * fetch belongs to the call, so a session kept past it would send later
 * calls' requests through a fetch whose call has ended.
 */
export class McpConnection {
  constructor(
    readonly address: ServerAddress,
    private readonly fetch: typeof globalThis.fetch,
  ) {}

  private async session<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'listen-fire', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(this.address.url), {
      requestInit: { headers: { [this.address.header.name]: this.address.header.value } },
      fetch: this.fetch,
    });
    try {
      await client.connect(transport);
      return await work(client);
    } catch (error) {
      throw failure(this.address, error);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** The server's tools, asked again: the start of each describe. */
  async listTools(): Promise<McpTool[]> {
    const tools = await this.session(async (client) => {
      const all: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        all.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return all;
    });
    const key = keyOf(this.address);
    listed.delete(key);
    listed.set(key, tools);
    if (listed.size > KEPT) {
      const [oldest] = listed.keys();
      if (oldest !== undefined) listed.delete(oldest);
    }
    return tools;
  }

  /** The tools last listed, listed now if none were. */
  async knownTools(): Promise<McpTool[]> {
    return listed.get(keyOf(this.address)) ?? this.listTools();
  }

  async tool(name: string): Promise<McpTool> {
    const tool = (await this.knownTools()).find((t) => t.name === name);
    if (tool === undefined) throw new Error(`MCP server ${this.address.url} has no tool "${name}" (any more).`);
    return tool;
  }

  /** One call. A refused call (`isError`) is an answer, not a failure here. */
  async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return this.session((client) => client.callTool({ name, arguments: args }) as Promise<McpCallResult>);
  }
}
