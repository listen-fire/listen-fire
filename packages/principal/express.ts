// The express adapter: resolve a request to a Principal and install it in the
// ambient store for the rest of the chain.
//
// The request/response types are structural on purpose — the package must not
// depend on express (a product may mount the same provider under Next route
// handlers or an MCP transport), and express's own types satisfy these shapes.

import { runWithPrincipalSync } from './ambient';
import type { PrincipalProvider, PrincipalRequest } from './principal';

interface ExpressRequestLike {
  method: string;
  url: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Present only when cookie-parser is mounted; the `cookie` header is the fallback. */
  cookies?: Record<string, string | undefined>;
}

interface ExpressResponseLike {
  status(code: number): ExpressResponseLike;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

type ExpressNextLike = (error?: unknown) => void;

function parseCookieHeader(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name !== '' && !cookies.has(name)) cookies.set(name, decodeURIComponent(value));
  }
  return cookies;
}

function principalRequestFromExpress(req: ExpressRequestLike): PrincipalRequest {
  let parsedCookies: Map<string, string> | undefined;

  return {
    method: req.method,
    url: req.originalUrl ?? req.url,

    header(name: string): string | undefined {
      const value = req.headers[name.toLowerCase()];
      if (value === undefined) return undefined;
      return Array.isArray(value) ? value[0] : value;
    },

    cookie(name: string): string | undefined {
      const fromParser = req.cookies?.[name];
      if (fromParser !== undefined) return fromParser;
      if (parsedCookies === undefined) {
        const header = req.headers.cookie;
        parsedCookies = parseCookieHeader(typeof header === 'string' ? header : '');
      }
      return parsedCookies.get(name);
    },
  };
}

/**
 * Mount early: everything downstream reads identity off the ambient store, so
 * a route reached before this middleware has no principal at all rather than a
 * weaker one.
 */
function principalMiddleware(options: { provider: PrincipalProvider }) {
  const { provider } = options;

  return function installPrincipal(
    req: ExpressRequestLike,
    res: ExpressResponseLike,
    next: ExpressNextLike,
  ): void {
    provider.authenticate(principalRequestFromExpress(req)).then(
      (result) => {
        if (!result.ok) {
          if (result.wwwAuthenticate !== undefined) {
            res.setHeader('WWW-Authenticate', result.wwwAuthenticate);
          }
          res.status(result.status).json({ error: result.message });
          return;
        }
        runWithPrincipalSync(result.principal, () => next());
      },
      (error: unknown) => next(error),
    );
  };
}

export {
  type ExpressRequestLike,
  type ExpressResponseLike,
  type ExpressNextLike,
  principalRequestFromExpress,
  principalMiddleware,
};
