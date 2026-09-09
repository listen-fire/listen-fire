'use client';

import { useMemo, useState } from 'react';
import { httpBatchLink, createWSClient, wsLink, splitLink } from '@trpc/client';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { trpc } from './trpc';
import { TAB_ORIGIN_ID } from './tab-origin';

/** Identifies this tab on every request, so resource-change events the
 *  tab causes can be filtered back out of its own subscriptions. */
const originHeaders = () => ({ 'x-listen-fire-origin': TAB_ORIGIN_ID });

/**
 * Wraps fetch so that non-JSON error responses (e.g. a raw "Internal Server Error"
 * from a reverse proxy) are converted into valid JSON before tRPC tries to parse them.
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

  const wsClient = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const wsUrl = new URL('/subscriptions/trpc', window.location.origin)
      .toString()
      .replace(/^http/, 'ws');
    return createWSClient({
      url: wsUrl,
      retryDelayMs: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
    });
  }, []);

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
