// MCP resource-server OAuth surface (RFC 9728 — OAuth 2.0 Protected Resource
// Metadata). The MCP authorization spec (2025-06-18) makes two MUST-level
// demands of an MCP server acting as a protected resource, both of which a
// remote connector (claude.ai) relies on to bootstrap OAuth:
//
//   1. A credential-less request MUST get a *401* carrying a `WWW-Authenticate:
//      Bearer resource_metadata="…"` header pointing at the resource's metadata
//      document. (Our global auth gate otherwise answers a bare 403, which the
//      connector reads as "forbidden, give up" — it never starts OAuth.)
//   2. That metadata document MUST be served and MUST list `authorization_servers`,
//      so the connector can find the AS metadata (`/.well-known/oauth-authorization-server`).
//
// This module supplies both, mounted BEFORE the auth gate (the challenge has to
// fire for unauthenticated requests; the metadata has to be publicly readable).
// A request that DOES carry a credential falls straight through to the normal
// auth gate, which validates it — so the Claude Code `Authorization: Bearer az_…`
// path is untouched.

import { Router, type RequestHandler } from 'express';

import { API_KEY_PREFIX } from '../../services/api_key';
import { AUTH_COOKIE } from '../../constants';
import { getOrigin } from './origin';

// The MCP mounts live at `/api/v1/mcp/<domain>`. Each is a distinct OAuth
// protected resource with its own canonical URI and its own coarse scope.
const MCP_BASE_PATH = '/api/v1/mcp';

const MCP_RESOURCE_SCOPES: Record<string, string> = {
  automation: 'automation',
  knowledge: 'knowledge',
  valuations: 'valuations',
};

// Does the request already carry SOME credential? If so we let the normal auth
// gate adjudicate it (a bad key still yields a 401 there). Only a request with
// NO credential at all needs the discovery challenge.
function hasCredential(req: import('express').Request): boolean {
  const auth = req.get('authorization');
  if (auth?.startsWith(`Bearer ${API_KEY_PREFIX}`)) return true;
  const apiKey = req.get('x-api-key');
  if (apiKey?.startsWith(API_KEY_PREFIX)) return true;
  if (req.cookies?.[AUTH_COOKIE]) return true;
  return false;
}

// The RFC 9728 metadata document URL for a given MCP resource path: the
// `/.well-known/oauth-protected-resource` segment is spliced between origin and
// the resource's own path (RFC 9728 §3.1).
function metadataUrlFor(origin: string, resourcePath: string): string {
  return `${origin}/.well-known/oauth-protected-resource${resourcePath}`;
}

/**
 * Mounted at `/api/v1/mcp`. For a credential-less request it answers the RFC
 * 9728 / MCP 401 challenge; otherwise it hands off to the real auth gate.
 */
const mcpAuthChallenge: RequestHandler = (req, res, next) => {
  if (hasCredential(req)) return next();

  const origin = getOrigin(req);
  // `req.originalUrl` is the full path the client hit (e.g.
  // `/api/v1/mcp/automation`); strip any query string for the canonical URI.
  const resourcePath = req.originalUrl.split('?')[0];
  const metadataUrl = metadataUrlFor(origin, resourcePath);

  res.set(
    'WWW-Authenticate',
    `Bearer resource_metadata="${metadataUrl}", error="unauthorized", error_description="Authentication required"`,
  );
  res.status(401).json({
    error: 'unauthorized',
    error_description: 'Authentication required. Authorize via OAuth or present a Listen-Fire API key.',
  });
};

function protectedResourceDocument(origin: string, resourcePath: string) {
  // The last path segment selects the connector.
  const domain = resourcePath.split('/').filter(Boolean).pop() ?? '';
  const scope = MCP_RESOURCE_SCOPES[domain];
  // Point each connector at its OWN authorization server (the resource URI is the
  // AS issuer), whose metadata advertises only this connector's scope — so the
  // client requests just that scope. Unknown paths fall back to the global AS.
  const authorizationServer = scope ? `${origin}${resourcePath}` : origin;
  return {
    resource: `${origin}${resourcePath}`,
    authorization_servers: [authorizationServer],
    bearer_methods_supported: ['header'],
    ...(scope ? { scopes_supported: [scope] } : {}),
  };
}

/**
 * Serves the RFC 9728 Protected Resource Metadata documents. Mounted before the
 * auth gate so the connector can read them unauthenticated.
 *
 * RFC 9728 §3.1 path form: `/.well-known/oauth-protected-resource` followed by
 * the resource's own path. We serve the per-resource path the WWW-Authenticate
 * header points at, plus a bare fallback for clients that probe the root.
 */
function createProtectedResourceRouter(): ReturnType<typeof Router> {
  const router = Router();

  // Per-MCP-resource metadata: `/.well-known/oauth-protected-resource/api/v1/mcp/<domain>`
  router.get(
    `/.well-known/oauth-protected-resource${MCP_BASE_PATH}/:domain`,
    (req, res) => {
      const origin = getOrigin(req);
      res.json(protectedResourceDocument(origin, `${MCP_BASE_PATH}/${req.params.domain}`));
    },
  );

  // Bare fallback — some clients fetch the root document and read
  // `authorization_servers` from it directly.
  router.get('/.well-known/oauth-protected-resource', (req, res) => {
    const origin = getOrigin(req);
    res.json({
      resource: origin,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
    });
  });

  return router;
}

export { createProtectedResourceRouter, mcpAuthChallenge, MCP_BASE_PATH, MCP_RESOURCE_SCOPES };
