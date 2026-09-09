import { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';

function initialiseWebSockets<T extends string>(schema: T[]) {
  const sockets = {} as Record<T, WebSocketServer>;
  for (const key of schema) {
    const wss = new WebSocketServer({ noServer: true });
    sockets[key as T] = wss;
  }

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!request.url) {
      socket.destroy();
      return;
    }

    const { pathname } = new URL(request.url, `wss://${request.headers.host}`);
    const wss = sockets[pathname.replace(/^\/subscriptions\//, '') as T];
    if (wss) {
      wss.handleUpgrade(request, socket, head, function done(ws) {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  };

  return {
    sockets,
    upgrade,
  };
}

export { initialiseWebSockets };
