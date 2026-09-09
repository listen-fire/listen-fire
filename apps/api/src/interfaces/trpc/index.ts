import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { TRPCError } from '@trpc/server';
import { WebSocketServer } from 'ws';

import { modelsRouter } from './models';
import { viewsRouter } from './views';
import { unauthorisedGetUserById } from '../../lib/middleware/authentication/identify_user';
import { Context } from '../../services/context';
import { authenticateWebsocket, installContextIdentity } from '../../services/principal';
import { refusalMessage } from '../../services/principal/core_provider';
import { refuseUnmountedWsMessage } from './product_gate';
import { trpc } from './trpc';

const trpcRouter = trpc.router({
  models: modelsRouter,
  views: viewsRouter,
});

function linkTrpcWsServer(wss: WebSocketServer) {
  const handler = applyWSSHandler({
    wss,
    router: trpcRouter,
    // The websocket is the provider's second call site (D19): the realtime
    // token arrives as the `ListenFireToken` subprotocol rather than a cookie, and
    // everything after that — impersonation, the acting-team membership gate,
    // the access level — is the one chain a request takes. `authorise` stays
    // lazy (tRPC calls it per procedure, inside that message's own Context), and
    // the identity it installs there is what the protected procedures make
    // ambient.
    createContext: async (args) => ({
      authorise: async () => {
        const outcome = await authenticateWebsocket(args.req);
        if (!outcome.ok) {
          // A stale cookie whose WS client reconnects every couple of seconds
          // is a client-side auth failure, not a server fault: classified so
          // the formatter logs it quietly rather than as INTERNAL_SERVER_ERROR.
          throw new TRPCError({ code: 'UNAUTHORIZED', message: refusalMessage(outcome) });
        }

        const { userId } = outcome.principal;
        if (userId === undefined) {
          // A machine credential has no user, and every WS surface is a signed-in
          // one. Refuse rather than serve a subscription attributed to nobody.
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Unauthenticated' });
        }

        installContextIdentity(outcome);
      },
    }),
  });

  wss.listeners('connection').forEach((listener) => {
    wss.removeListener('connection', listener as (...args: unknown[]) => void);
    wss.addListener('connection', (socket: WebSocketServer, request: unknown) => {
      if (socket.on.name !== 'replacedOnListener') {
        const on = socket.on.bind(socket);
        socket.on = function replacedOnListener(event, handler) {
          if (event !== 'message') {
            return on(event, handler);
          }

          return on(event, async (...args: Parameters<typeof handler>) => {
            // The product gate's websocket half. The path travels in the frame
            // rather than the URL here, so it is checked before the message
            // reaches tRPC at all (product_gate.ts).
            const refusal = refuseUnmountedWsMessage(
              typeof args[0] === 'string' ? args[0] : String(args[0]),
            );
            if (refusal !== undefined) {
              (socket as unknown as { send(data: string): void }).send(refusal);
              return;
            }
            // eslint-disable-next-line
            new Context().runAsync(() => (handler as any).apply(socket, args)).catch(console.error);
          });
        };
      }

      return listener(socket, request);
    });
  });

  process.on('SIGTERM', () => {
    handler.broadcastReconnectNotification();
    wss.close();
  });
}

// eslint-disable-next-line local-rules/bottom-exports
export type TRPCRouter = typeof trpcRouter;
// eslint-disable-next-line local-rules/bottom-exports
export { trpcRouter, linkTrpcWsServer };
