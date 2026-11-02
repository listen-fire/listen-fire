// Loaded before every lf-cli test file (package.json's test scripts).
//
// The tests talk to their fake servers with the global fetch, whose pool keeps
// an idle connection open to reuse it, and closes it itself a second before
// the fake would (a fake, a node http server in its own process, closes one
// after 5 s idle). But a test blocks its own event loop while it runs
// listen-fire synchronously, and under load that can outlast 5 s: the pool's
// timer never fires, the fake closes the connection, and the next request
// goes out on it and fails on the reset socket ('fetch failed') before the
// fake ever read it. Such a request is sent once more, on a fresh connection.
// Any other failure is the test's to see.

const SOCKET_GONE = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);

function socketGone(error: unknown): string | undefined {
  if (!(error instanceof TypeError)) return undefined;
  const cause: unknown = error.cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
  const { code } = cause;
  return typeof code === 'string' && SOCKET_GONE.has(code) ? code : undefined;
}

// A body that is read as it is sent cannot be sent twice.
function resendable(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): boolean {
  if (input instanceof Request && input.body !== null) return false;
  return !(init?.body instanceof ReadableStream);
}

const send = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  try {
    return await send(input, init);
  } catch (error) {
    const code = socketGone(error);
    if (code === undefined || !resendable(input, init)) throw error;
    process.stderr.write(`fetch: ${code} on a reused connection to ${String(input instanceof Request ? input.url : input)}; sent once more\n`);
    return send(input, init);
  }
};
