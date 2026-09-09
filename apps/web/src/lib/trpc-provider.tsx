'use client';

import { useEffect, useMemo, useState } from 'react';
import { httpBatchLink, createWSClient, wsLink, splitLink } from '@trpc/client';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { trpc } from './trpc';
import { apiOrigin as resolveApiOrigin } from './api-origin';
import { useCapabilities, useCapabilitiesSettled } from './capabilities-provider';
import { TAB_ORIGIN_ID } from './tab-origin';

/** Identifies this tab on every request, so resource-change events the
 *  tab causes can be filtered back out of its own subscriptions. */
const originHeaders = () => ({ 'x-listen-fire-origin': TAB_ORIGIN_ID });

/**
 * Wraps fetch so that non-JSON error responses (e.g. a raw "Internal Server Error"
 * from a reverse proxy) are converted into valid JSON before tRPC tries to parse them.
 * Without this, the JSON.parse inside httpBatchLink throws a SyntaxError that escapes
 * normal tRPC/React-Query error handling and can crash the UI.
 */
async function resilientFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);

  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      return new Response(
        JSON.stringify({
          error: {
            message: text || response.statusText,
            code: -32603,
            data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: response.status },
          },
        }),
        {
          status: response.status,
          statusText: response.statusText,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
  }

  return response;
}

export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        mutationCache: new MutationCache({
          onError: () => {},
        }),
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  // Short-lived realtime token for the WS subprotocol. The session cookie is
  // httpOnly (invisible to JS) and can't reach the cross-origin WS handshake, so
  // we fetch a scoped token from a same-origin, cookie-authed endpoint.
  //
  // The endpoint mounts with core, so a static-identity install does not have
  // it — asking anyway is a 404 on every page load. Waiting for the probe to
  // settle rather than reading a null answer as "core" is what keeps that from
  // happening once on first paint regardless.
  const capabilities = useCapabilities();
  const settled = useCapabilitiesSettled();
  const staticIdentity = capabilities?.identity === 'static';
  const [wsToken, setWsToken] = useState<string | null>(null);
  useEffect(() => {
    if (!settled || staticIdentity) return;
    let cancelled = false;
    fetch('/api/public/auth/realtime-token')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.token) setWsToken(d.token as string);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [settled, staticIdentity]);

  const wsClient = useMemo(() => {
    if (typeof window === 'undefined' || !wsToken) return null;

    // WS upgrades don't ride the Next.js rewrite for `/subscriptions/*`, so
    // connect straight to the API origin and carry the realtime token via the
    // `ListenFireToken` subprotocol — the exact mechanism the server's `authorise`
    // reads (apps/api trpc/index.ts).
    const apiOrigin = resolveApiOrigin() || window.location.origin;
    const wsUrl = new URL('/subscriptions/trpc', apiOrigin)
      .toString()
      .replace(/^http/, 'ws');

    // Bind the (now non-null) token to a local so it's captured as `string` in
    // the nested class constructor below.
    const token = wsToken;
    class ListenFireTokenWebSocket extends WebSocket {
      constructor(url: string | URL) {
        super(url, ['ListenFireToken', token]);
      }
    }

    return createWSClient({
      url: wsUrl,
      retryDelayMs: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
      WebSocket: ListenFireTokenWebSocket,
    });
  }, [wsToken]);

  const trpcClient = useMemo(
    () =>
      trpc.createClient({
        links: [
          splitLink({
            condition: (op) => op.type === 'subscription',
            true: wsClient
              ? wsLink({ client: wsClient })
              : httpBatchLink({ url: '/api/trpc', fetch: resilientFetch, headers: originHeaders }),
            false: httpBatchLink({ url: '/api/trpc', fetch: resilientFetch, headers: originHeaders }),
          }),
        ],
      }),
    [wsClient],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
