// One MCP server, reached as one connection: the server's URL and how to sign
// in come from the connection's credential, never from the install, so two
// connections of this module reach two servers. Streamable HTTP only: a
// connection never starts a local process.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RetriesExhaustedError, networkErrorCode, retryingFetch, type AttemptFailure, type CredentialFields, type RetryFetchOptions, type RetryNote } from 'module-kit';

import { isReadOnly, type McpCallResult, type McpTool } from './tools';

export type { RetryNote };

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
  if (url === '') throw new Error(`MCP: the credential holds no server url. Add it: listen-fire credential update <name>.`);
  if (!/^https?:\/\//.test(url)) throw new Error(`MCP: the server url "${url}" is not an http(s) URL; a connection reaches its server over streamable HTTP only.`);
  if (credential === TOKEN_CREDENTIAL) {
    const token = fields.token ?? '';
    if (token === '') throw new Error('MCP: the credential holds no token.');
    const header = fields.header?.trim() ?? '';
    return { url, header: header === '' ? { name: 'authorization', value: `Bearer ${token}` } : { name: header, value: token } };
  }
  const token = fields.access_token ?? '';
  if (token === '') throw new Error('MCP: the credential holds no access token. Sign in again: listen-fire credential update <name>.');
  return { url, header: { name: 'authorization', value: `Bearer ${token}` } };
}

/** Errors that say the request never reached the server: the only network
 *  failures after which a tool that changes things may be sent again. A reset
 *  or a closed socket may come after the server acted. */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

function isToolCall(init: RequestInit | undefined): boolean {
  if (typeof init?.body !== 'string') return false;
  try {
    const message: unknown = JSON.parse(init.body);
    return typeof message === 'object' && message !== null && Reflect.get(message, 'method') === 'tools/call';
  } catch {
    return false;
  }
}

/** Whether a failed request may be sent again. initialize, tools/list and a
 *  read-only tool's call can be, whatever failed; a call to a tool that
 *  changes things only when the server clearly did not act on it: it asked
 *  for the wait (429, 503 with a Retry-After) or was never reached. */
function mayResend(failure: AttemptFailure, init: RequestInit | undefined, readOnlyCall: boolean): boolean {
  if (readOnlyCall || !isToolCall(init)) return true;
  if (failure.kind === 'network') return NEVER_SENT.has(networkErrorCode(failure.error) ?? '');
  return failure.status === 429 || (failure.status === 503 && failure.retryAfterMs !== undefined);
}

/** What a failed exchange with the server says, the server's own words kept. */
function failure(address: ServerAddress, error: unknown): Error {
  if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
    return new Error(`MCP server ${address.url} refused the credential (HTTP ${error.code}).`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`MCP server ${address.url}: ${message}`, error instanceof RetriesExhaustedError ? { cause: error } : undefined);
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
 * call (`ctx.fetch`: the limiter's door under listen-fire, the host's own client in
 * process). A session lives for the one exchange it opens for: the host's
 * fetch belongs to the call, so a session kept past it would send later
 * calls' requests through a fetch whose call has ended.
 */
export interface ConnectionOptions {
  /** The retry policy's numbers (attempts, delays, budget); the defaults of `retryingFetch`. */
  retry?: Pick<RetryFetchOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs' | 'budgetMs' | 'sleep' | 'now' | 'random'>;
  /** Told before each retry's wait. */
  onRetry?: (note: RetryNote) => void;
}

export class McpConnection {
  constructor(
    readonly address: ServerAddress,
    private readonly fetch: typeof globalThis.fetch,
    private readonly options: ConnectionOptions = {},
  ) {}

  /** `readOnlyCall`: the one tool call this session makes (if any) is a
   *  read-only tool's, so it may be sent again whatever failed. */
  private async session<T>(work: (client: Client) => Promise<T>, readOnlyCall = false): Promise<T> {
    const client = new Client({ name: 'listen-fire', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(this.address.url), {
      requestInit: { headers: { [this.address.header.name]: this.address.header.value } },
      fetch: retryingFetch(this.fetch, {
        ...this.options.retry,
        mayRetry: (failure, init) => mayResend(failure, init, readOnlyCall),
        ...(this.options.onRetry === undefined ? {} : { onRetry: this.options.onRetry }),
      }),
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
    // A tool not listed (yet) is taken to change things.
    const tool = listed.get(keyOf(this.address))?.find((t) => t.name === name);
    return this.session((client) => client.callTool({ name, arguments: args }) as Promise<McpCallResult>, tool !== undefined && isReadOnly(tool));
  }
}
