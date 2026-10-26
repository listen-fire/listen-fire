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

/** A session with one server, opened on first use and kept while the process
 *  lives; any failure closes it, so the next call opens a fresh one. */
export class McpConnection {
  private client?: Promise<Client>;
  private tools?: McpTool[];

  constructor(readonly address: ServerAddress) {}

  private open(): Promise<Client> {
    if (this.client === undefined) {
      const opening = (async () => {
        const client = new Client({ name: 'listen-fire', version: '1' });
        const transport = new StreamableHTTPClientTransport(new URL(this.address.url), {
          requestInit: { headers: { [this.address.header.name]: this.address.header.value } },
        });
        await client.connect(transport);
        return client;
      })();
      this.client = opening;
      opening.catch(() => this.drop(opening));
    }
    return this.client;
  }

  /** Close the session, if one is open. */
  close(): void {
    if (this.client !== undefined) this.drop(this.client);
  }

  private drop(which: Promise<Client>): void {
    if (this.client !== which) return;
    this.client = undefined;
    this.tools = undefined;
    void which.then((c) => c.close()).catch(() => undefined);
  }

  private async session<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = this.open();
    try {
      return await work(await client);
    } catch (error) {
      this.drop(client);
      throw failure(this.address, error);
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
    this.tools = tools;
    return tools;
  }

  /** The tools last listed, listed now if none were. */
  async knownTools(): Promise<McpTool[]> {
    return this.tools ?? this.listTools();
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

const connections = new Map<string, McpConnection>();
/** Sessions kept at once; the oldest is closed past it. */
const KEPT = 64;

/** The session for a server and sign-in: one per pair, shared by every call
 *  this process serves under it. A refreshed token is a new pair. */
export function connectionFor(address: ServerAddress): McpConnection {
  const key = JSON.stringify([address.url, address.header.name, address.header.value]);
  const found = connections.get(key);
  if (found !== undefined) return found;
  const made = new McpConnection(address);
  connections.set(key, made);
  if (connections.size > KEPT) {
    const [oldest] = connections.entries();
    if (oldest !== undefined) {
      connections.delete(oldest[0]);
      oldest[1].close();
    }
  }
  return made;
}

/** Close every session this process holds. */
export function closeConnections(): void {
  for (const connection of connections.values()) connection.close();
  connections.clear();
}
