// `@lf/mcp`: any remote MCP server as a module. The module is fixed; a
// connection carries data only, the server's URL and how to sign in, in one of
// two credentials: a token (`mcp_token`, sent as a bearer or under a header
// the credential names) or an OAuth sign-in (`mcp`). The OAuth endpoints and
// app belong to the install (`lf connect @lf/mcp --oauth-authorize-url …
// --oauth-token-url …`), so OAuth reaches one server per install; a token
// reaches any number.

import { defineModule, type ModuleContext } from 'module-kit';

import { McpAdapter, type ConnectionSource } from './adapter';
import { OAUTH_CREDENTIAL, TOKEN_CREDENTIAL, addressOf, connectionFor } from './client';
import { MCP_MANIFEST } from './manifest';

/** The connection the context's credential names. */
export function connectionFrom(ctx: ModuleContext): ConnectionSource {
  return async () => connectionFor(addressOf(ctx.credential.name, await ctx.credential.fields()));
}

const URL_FIELD = { name: 'url', label: 'The MCP server URL (streamable HTTP)', secret: false } as const;

export const mcpModule = defineModule({
  kind: 'adapter',
  name: '@lf/mcp',
  manifest: MCP_MANIFEST,
  credentials: [
    {
      name: OAUTH_CREDENTIAL,
      kind: 'oauth2',
      fields: [URL_FIELD],
      // An MCP server names its own authorization server, so these are only
      // where the install's override has not been set: lf connect @lf/mcp
      // --oauth-authorize-url … --oauth-token-url … sets it.
      oauth2: {
        authorizeUrl: 'https://mcp-authorization.invalid/authorize',
        tokenUrl: 'https://mcp-authorization.invalid/token',
        clientAuth: 'body',
        pkce: true,
      },
    },
    {
      name: TOKEN_CREDENTIAL,
      kind: 'static',
      fields: [
        URL_FIELD,
        { name: 'token', label: 'Token' },
        { name: 'header', label: 'Header to send the token in, as written (default: Authorization: Bearer <token>)', secret: false, optional: true },
      ],
    },
  ],
  create: (ctx) => new McpAdapter(connectionFrom(ctx)),
});

export default mcpModule;

export * from './adapter';
export * from './client';
export * from './manifest';
export * from './schema';
export * from './tools';
