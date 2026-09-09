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
  '/api/auth/:path*',
  '/subscriptions/:path*',
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
