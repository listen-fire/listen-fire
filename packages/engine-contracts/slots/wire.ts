// The one transport every module kind is reached over: adapter protocol 2's
// HTTP (docs/contracts/adapter-protocol.md). A core module filling a slot is
// a protocol-2 server like any adapter: one POST per method, the envelope
// `{ ok, result }` or `{ ok: false, error }`, its install's settings carried
// on every request. It listens on a Unix socket when it runs on the host's
// box, on loopback TCP where there are no sockets, and on HTTPS when it is
// remote. Its address is written as a base URL: `unix:<socket path>`,
// `http://host:port/` or `https://…`. A module the host starts is told where
// to listen by `MODULE_SOCKET` (else `PORT`), and prints `listening
// unix:<path>` (or `listening <port>`).
//
// The shapes only: a Node client, server and starter are module-runtime's
// `module-wire`.

import { z } from 'zod';

import { CORE_SLOTS, PROTOCOL_VERSION, WireManifestProtocolMinor } from '../protocol';

export const SlotRequestEnvelope = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  method: z.string().min(1),
  cacheScopeId: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const SlotError = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  /** What a code carries beside its message (the store's `run_lease_lost`: `{ runId }`). */
  data: z.unknown().optional(),
});

export const SlotAnswerEnvelope = z.union([
  z.object({ ok: z.literal(true), result: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: SlotError }),
]);

/** What a core module answers `manifest` with. */
export const WireSlotManifest = z.object({
  protocolVersion: z.literal(2),
  protocolMinor: WireManifestProtocolMinor,
  name: z.string().min(1),
  kind: z.literal('core'),
  slot: z.enum(CORE_SLOTS),
  methods: z.array(z.string()),
});
export type WireSlotManifestShape = z.infer<typeof WireSlotManifest>;

/** The error code a store answers when a fenced write finds the run's lease gone. */
export const RUN_LEASE_LOST_CODE = 'run_lease_lost';

/** The most a module must hold a `<slot>.watch` request: listen-fire asks for at most
 *  this, and a module honours at most this whatever `waitMs` says. */
export const WATCH_WAIT_CAP_MS = 30_000;

/**
 * The generic change feed any slot may adopt (`<slot>.watch`, the adapter
 * protocol's "Watching for changes"). The caller holds a cursor and asks for
 * what happened after it; the module holds the request up to `waitMs`, then
 * answers.
 *
 * - An absent cursor answers the module's current cursor and no events.
 * - `waitMs` is a non-negative integer; a module honours at most
 *   `WATCH_WAIT_CAP_MS` and may answer sooner, at once with `events: []`.
 * - A cursor the module never gave, or can no longer serve, answers
 *   `{ resync: true }`: the caller lists afresh and asks without a cursor.
 * - Events from one cursor are in order, and a cursor a module has answered is
 *   never answered again with fewer events.
 * - Cursors are positions in the module's log, not per caller: every caller
 *   holding a cursor sees every event after it.
 */
export const WatchRequest = z.object({ cursor: z.string().min(1).optional(), waitMs: z.number().int().min(0) });
export type WatchRequestShape = z.infer<typeof WatchRequest>;

export function watchAnswer<E extends z.ZodType>(event: E) {
  return z.union([z.object({ cursor: z.string().min(1), events: z.array(event) }), z.object({ resync: z.literal(true) })]);
}
