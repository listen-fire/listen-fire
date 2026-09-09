/**
 * Every path the Next server hands to the API, in one list, with the two ways
 * it hands them over.
 *
 * `next.config.ts` turns the list into rewrites. Next compiles rewrites into
 * the build's route manifest, so their destination is frozen at BUILD time —
 * which is fine for a deployment that knows its API when it builds, and useless
 * for a self-host image that must reach whatever API the operator names when
 * the container starts. So `middleware.ts` re-points the same paths at
 * `API_INTERNAL_URL` per request, and only when that variable is set: with it
 * unset, nothing changes and the baked rewrites are still the whole story.
 */
export const API_PROXY_SOURCES = [
  '/api/trpc/:path*',
  '/api/public/:path*',
  // The async-interaction answer surface — the `/a/<token>` page fetches the
  // ask detail + submits the answer same-origin (the token is the auth).
  '/api/asks/:path*',
  '/api/auth/:path*',
  '/api/upload_retrievable',
  '/subscriptions/:path*',
  // The whole versioned API surface: MCP servers at /api/v1/mcp, and the
  // REST endpoints the API explorer hands people as copyable curl commands
  // (/api/v1/knowledge/cypher), which have to work against the container too.
  '/api/v1/:path*',
  '/.well-known/oauth-authorization-server',
  // Per-connector authorization-server metadata (RFC 8414 path-aware form),
  // e.g. `/.well-known/oauth-authorization-server/api/v1/mcp/automation`.
  '/.well-known/oauth-authorization-server/:path*',
  // RFC 9728 protected-resource metadata — the doc that carries each MCP
  // resource's canonical URI + its authorization server, which the connector
  // needs to discover scopes. Both the bare doc and the per-resource path.
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/:path*',
  '/oauth/:path*',
] as const;

const SUFFIX = '/:path*';

export function apiProxyRewrites(apiUrl: string): { source: string; destination: string }[] {
  return API_PROXY_SOURCES.map((source) => ({ source, destination: `${apiUrl}${source}` }));
}

/** Whether a request path is one the rewrites above would send to the API. */
export function isProxiedApiPath(pathname: string): boolean {
  return API_PROXY_SOURCES.some((source) => {
    if (!source.endsWith(SUFFIX)) return pathname === source;
    // `:path*` matches zero or more segments, so the bare prefix counts too.
    const base = source.slice(0, -SUFFIX.length);
    return pathname === base || pathname.startsWith(`${base}/`);
  });
}

/**
 * The API origin to proxy to at request time, or undefined when the build's
 * baked rewrites should be left alone.
 */
export function runtimeApiTarget(): string | undefined {
  return process.env.API_INTERNAL_URL || undefined;
}
