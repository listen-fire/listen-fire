// Reproduces the production symptom directly: a client (an MCP connector's
// long-lived SSE GET, or any long-running request) closes its socket while
// the server is still handling it. Root cause: `contextInjector`'s
//   ctx.run(() => { ... }).catch((err) => { throw err; })
// `ctx.run()` rejects whenever the Context's 'error' event fires during its
// lifetime (`waitForEvent('close')`, which `run()` awaits, ALSO subscribes to
// 'error' and rejects on it) — which happens the moment `req.on('error', ...)`
// sees the client's socket reset and calls `ctx.error(err)`. The `.catch()`
// here caught that rejection only to immediately rethrow it into a floating
// promise nothing ever awaits or catches — an unhandled rejection by
// construction, on every request whose client disconnected before the
// Context closed. An MCP connector's SSE stream — open for minutes — gives
// this a huge window to fire.
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';

import express from 'express';

import { contextInjector, isClientAbort } from '../context';

describe('isClientAbort', () => {
  it('recognizes the client-disconnect signature Node raises on an aborted request', () => {
    const err = new Error('aborted');
    (err as NodeJS.ErrnoException).code = 'ECONNRESET';
    expect(isClientAbort(err)).toBe(true);
  });

  it('does not classify an unrelated error as a client abort', () => {
    expect(isClientAbort(new Error('boom'))).toBe(false);
    expect(isClientAbort('aborted')).toBe(false);
    expect(isClientAbort(undefined)).toBe(false);
  });
});

describe('contextInjector: client disconnects mid-request', () => {
  it('does not leak an unhandled rejection when the socket is destroyed before the response completes', async () => {
    const app = express();
    app.use(contextInjector);
    app.get('/slow', (_req, res) => {
      // Stands in for an MCP SSE stream: still open, nothing sent back yet,
      // when the client goes away. The timeout never fires in this test —
      // the server is closed first — it just keeps the handler (and the
      // request) "in flight" the way a real long poll would.
      setTimeout(() => res.end('too late'), 30_000).unref();
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const socket = net.connect(port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write('GET /slow HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');

      // Let the request route through contextInjector (which registers its
      // req.on('error', ...) listener) before the socket disappears.
      await new Promise((resolve) => setTimeout(resolve, 100));
      socket.destroy();

      // Give the server's abort/close machinery a chance to run — this is
      // exactly where the unhandled rejection used to surface.
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
