// Wire protocol server — the counterpart to `client.ts`. Turns ANY in-process
// `Adapter` into a Node `http` request handler that speaks the remote-adapter
// protocol, so a `RemoteAdapter` (driving it over real HTTP) behaves
// identically to driving the adapter in-process.
//
// Symmetry with the client (`client.ts`):
//   • Both `ok:true` and `ok:false` are HTTP 200 — application-level errors
//     ride inside the envelope (see `3_model.md` "Envelope"). The client's
//     `postRpc` only raises a `RemoteTransportError` on non-2xx, so we reserve
//     non-2xx for genuine transport faults (malformed body, auth) and use the
//     `{ok:false}` envelope for every dispatch-level failure.
//   • Auth failure → HTTP 401, matching the client's `RemoteTransportError`
//     (non-retryable status the engine surfaces as an evaluation error).
//
// Streaming methods (`iterateRelated`) return an `AsyncIterable`
// from the adapter. The protocol pages them as `{ items, nextCursor }`. The
// degenerate-but-correct implementation here drains the whole iterable into a
// single page on the first (cursorless) call and returns no `nextCursor`; the
// client's page loop terminates immediately. A production server would slice
// the iterable into bounded pages and emit an opaque `nextCursor` — a single
// page is a valid cursor implementation (one page, no continuation).
//
// Dependency-light by design: Node `http` types only, no express.

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

import type { Adapter } from '../adapter';
import { RpcRequest, METHODS } from './schema';
import type { MethodName, RpcResponseShape } from './schema';

/**
 * Protocol method names that exist purely as server-side concepts (no
 * matching `Adapter` member): `manifest` is synthesised from the adapter's
 * readonly props. Everything else in `METHODS` maps 1:1 to an `Adapter`
 * member of the same name.
 */
const MANIFEST_METHOD = 'manifest' satisfies MethodName;

/**
 * Methods the protocol delivers as paged `{ items, nextCursor }` even though
 * the underlying `Adapter` member returns an `AsyncIterable`. The server
 * drains the iterable into a single page (see file header).
 */
const STREAMING_METHODS = new Set<MethodName>(['iterateRelated']);

/**
 * A few `Adapter` members take a single POSITIONAL argument rather than an
 * options object, while the wire protocol uniformly wraps params in an object
 * (`describe` → `{ typeId }`). For these the server unwraps the named field
 * before applying the call so the in-process method sees its native
 * positional argument. Every other method takes the wire params object
 * directly.
 */
const POSITIONAL_PARAM_FIELDS: Partial<Record<MethodName, readonly string[]>> = {
  describe: ['typeId'],
  edgesFrom: ['position', 'cursor'],
};

/**
 * Map a method's wire params into the argument LIST the in-process `Adapter`
 * member expects — unwrapping the named fields in order for positional-arg
 * methods, otherwise forwarding the params object verbatim as a single
 * argument. Ordered rather than single-valued: a positional method may take
 * more than one argument, and plucking just the first would silently drop the
 * rest at the in-process bridge (the failure mode when `describe` grows a
 * position — see plans/2026-07-10-adapter-entry-positions/3_edges_from.md).
 */
function callArgs(method: MethodName, params: unknown): unknown[] {
  const fields = POSITIONAL_PARAM_FIELDS[method];
  if (fields && params && typeof params === 'object') {
    return fields.map((field) => (params as Record<string, unknown>)[field]);
  }
  return [params];
}

/**
 * Compute the set of protocol methods this adapter actually implements —
 * a member is "implemented" when it is a function on the instance (own or
 * prototype). `manifest` is always implemented (synthesised). Optional
 * `Adapter` methods the instance pruned to `undefined` (the `RemoteAdapter`
 * pattern) or never defined are excluded.
 */
function implementedMethods(adapter: Adapter): MethodName[] {
  const all = Object.keys(METHODS) as MethodName[];
  return all.filter((method) => {
    if (method === MANIFEST_METHOD) return true;
    // `resolveFileRef`'s wire bridging (stream → hosted URL) is not yet
    // implemented by the generic server (see the dispatch guard); never
    // advertise it from the in-process bridge.
    if (method === 'resolveFileRef') return false;
    return typeof (adapter as unknown as Record<string, unknown>)[method] === 'function';
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: RpcResponseShape): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function errorEnvelope(code: string, message: string, retryable: boolean): RpcResponseShape {
  return { ok: false, error: { code, message, retryable } };
}

/**
 * Build the server handler for one adapter instance.
 *
 * `methods` defaults to the methods the adapter actually implements (computed
 * by inspecting which `Adapter` members are functions on the instance). Pass
 * an explicit list to advertise a narrower / different set in the `manifest`
 * response.
 *
 * `authenticate`, when provided, gates every request: returning `false`
 * responds HTTP 401 with a non-retryable `unauthorized` envelope.
 */
export function createAdapterProtocolHandler(opts: {
  adapter: Adapter;
  methods?: readonly string[];
  authenticate?: (headers: IncomingHttpHeaders) => boolean;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { adapter, authenticate } = opts;
  const advertisedMethods = opts.methods ?? implementedMethods(adapter);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ── Auth ──────────────────────────────────────────────────────────────
    // 401 (not an in-envelope error) so the client's transport layer treats
    // it the same as any other non-2xx — see `client.ts` `postRpc`.
    if (authenticate && !authenticate(req.headers)) {
      send(res, 401, errorEnvelope('unauthorized', 'Authentication failed.', false));
      return;
    }

    // ── Parse ─────────────────────────────────────────────────────────────
    let parsed;
    try {
      const raw = await readBody(req);
      parsed = RpcRequest.parse(JSON.parse(raw));
    } catch (err) {
      // Genuinely malformed transport (non-JSON / envelope shape violation)
      // → HTTP 400. The client raises a (retryable) transport error; a
      // well-formed client never hits this.
      send(
        res,
        400,
        errorEnvelope(
          'bad_request',
          `Malformed request: ${err instanceof Error ? err.message : String(err)}`,
          false,
        ),
      );
      return;
    }

    const { method, params } = parsed;

    // ── Manifest ──────────────────────────────────────────────────────────
    if (method === MANIFEST_METHOD) {
      send(res, 200, {
        ok: true,
        result: {
          adapterType: adapter.adapterType,
          supportedTriggers: adapter.supportedTriggers,
          runtimeCapabilities: adapter.runtimeCapabilities(),
          methods: advertisedMethods,
          webhookEventTypeId: adapter.webhookEventTypeId,
        },
      });
      return;
    }

    // Unknown method (not in the registry) is a dispatch-level failure.
    if (!(method in METHODS)) {
      send(
        res,
        200,
        errorEnvelope('method_not_implemented', `Unknown method "${method}".`, false),
      );
      return;
    }

    // `resolveFileRef` is the one method whose in-process return shape
    // (`{ stream }`) does NOT match its wire result shape (`{ url }`): a Node
    // stream can't ride the JSON envelope. A server fronting a file-owning
    // adapter must host the bytes behind a URL and return that — which needs
    // the registry/token + pass-through machinery on the server side. That
    // wiring lands in a later slice (no in-process adapter emits FileRefs in
    // 1a), so the generic dispatch below would mis-serialise the stream.
    // Until then, advertise it as unimplemented so the generic path never
    // runs for it. The client (`RemoteAdapter.resolveFileRef`) is the
    // consumer; it talks to a real owner server, not this generic bridge.
    if (method === 'resolveFileRef') {
      send(
        res,
        200,
        errorEnvelope(
          'method_not_implemented',
          'resolveFileRef url-hosting is not yet implemented by the generic protocol server.',
          false,
        ),
      );
      return;
    }

    const member = (adapter as unknown as Record<string, unknown>)[method];
    if (typeof member !== 'function') {
      send(
        res,
        200,
        errorEnvelope(
          'method_not_implemented',
          `Adapter does not implement "${method}".`,
          false,
        ),
      );
      return;
    }

    // ── Dispatch ──────────────────────────────────────────────────────────
    const args = callArgs(method as MethodName, params);
    try {
      if (STREAMING_METHODS.has(method as MethodName)) {
        const result = await drainStream(member.call(adapter, ...args));
        send(res, 200, { ok: true, result });
        return;
      }

      const result = await member.call(adapter, ...args);
      send(res, 200, { ok: true, result: result ?? null });
    } catch (err) {
      // Any throw inside the adapter becomes a retryable dispatch error —
      // the engine decides whether to retry. Source-only adapters that throw
      // on writes (email) surface here as a structured envelope, not a 500.
      send(
        res,
        200,
        errorEnvelope(
          'adapter_error',
          err instanceof Error ? err.message : String(err),
          true,
        ),
      );
    }
  };
}

/**
 * Drain an `AsyncIterable` into a single protocol page. Real servers would
 * page; one page (no `nextCursor`) is the degenerate-but-correct
 * implementation — the client's page loop terminates after it.
 */
async function drainStream(iterable: unknown): Promise<{ items: unknown[] }> {
  const items: unknown[] = [];
  for await (const item of iterable as AsyncIterable<unknown>) {
    items.push(item);
  }
  return { items };
}
