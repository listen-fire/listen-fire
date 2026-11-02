// Loaded before every lf-cli test file (package.json's test scripts).
//
// The tests talk to their fake servers with the global fetch, whose pool keeps
// an idle connection open to reuse, and drops it itself a second before the
// fake would (a fake, a node http server in its own process, closes one after
// 5 s idle). But a test blocks its own event loop while it runs listen-fire
// synchronously, and under load that can outlast 5 s: the pool's timer never
// fires, the fake closes the connection, and the next request goes out on it
// and fails on the reset socket ('fetch failed'). So a request to a fake, on
// this machine, asks for its connection to be closed once it is answered, and
// no request ever finds a connection the fake has closed. Requests anywhere
// else are untouched.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function toLoopback(input: Parameters<typeof fetch>[0]): boolean {
  const url = input instanceof Request ? input.url : String(input);
  return URL.canParse(url) && LOOPBACK.has(new URL(url).hostname);
}

const send = globalThis.fetch;

globalThis.fetch = (input, init) => {
  if (!toLoopback(input)) return send(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('connection', 'close');
  return send(input, { ...init, headers });
};
