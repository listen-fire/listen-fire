// The AWAITABLE capability (asks-as-adapter chunk B, layer 3 §A). An adapter
// that advertises awaitable edges takes on exactly two duties — CORRELATION
// (hold the map from its native identity to the engine's parks, so an inbound
// resolution finds the parks to resume) and CANCELLATION (receive the one
// signal, drop the correlation entry). The engine owns parking, resume, and
// WHERE evaluation; the adapter owns identity + its internal cancel-vs-resolve
// races (F17).
//
// This is a NARROW, delivery-orthogonal capability (P12): it is NOT rendering,
// delivery, uniqueness, or streams (`fires` owns those). Only the ask adapter
// implements it in chunk B; Slack `Replies` is chunk E. The interface is specced
// generically so the second declarant doesn't bend the design.

/** What a live check-now (`await x-[:E]->`) resolves to right now. */
export type AwaitResolution =
  /** Nothing has landed yet — the engine parks the leaf (armed). */
  | { status: 'pending' }
  /** The edge resolves to ≥1 landing — the engine binds them (after applying
   *  the await's WHERE) and continues inline. Each landing carries the fields
   *  the resumed body reads (`r.answer`). */
  | { status: 'landed'; landings: AwaitLanding[] }
  /** A `resolvesEmpty` settlement (an ask explicitly cancelled → expired, F6):
   *  the await completes immediately with an EMPTY match — downstream blocks run
   *  zero times. Only legal on an edge declared `resolvesEmpty`. */
  | { status: 'empty' };

/** One landing along an awaited edge — the node the resolution carries. */
export interface AwaitLanding {
  /** The landing record's id, when it has one (correlation, not stability —
   *  absent is fine). */
  recordId?: string;
  /** The landing node's NATURAL type name (`Response` for an ask, `Message` for
   *  a Slack reply). The engine binds a position of this type, so the resumed
   *  body's field reads AND the await's WHERE resolve through the adapter's own
   *  `getFieldValue` for that type. Absent ⇒ a fields-less/empty node. */
  recordType?: string;
  /** The landing's fields, keyed by whatever `getFieldValue` for `recordType`
   *  reads (the ask keys `Answer`; Slack rides the raw message payload its
   *  message reads already key by). Never pre-translated to the author's names
   *  — the engine reads them back through the adapter, same path as any read. */
  fields: Record<string, unknown>;
}

/** The identity of one awaited edge instance — the head record + the edge. */
export interface AwaitPoint {
  /** The head record the edge walks from (the written ask's id). */
  recordId: string;
  /** The awaited edge's name (`Response`). */
  edge: string;
  /** Everything a normal traversal of the head gets — the head's inline position
   *  data (ruling 2026-07-24: "the engine passes the adapter everything a normal
   *  traversal gets PLUS the park id"). An adapter whose correlation identity is
   *  NOT the bare `recordId` reads it here: Slack's `Replies` correlates on the
   *  channel + thread, which ride the write handle's data, not its `ts`. Absent
   *  for a head with no inline data. */
  headData?: Record<string, unknown>;
}

/** The engine park an await registers against a watch-point. */
export interface AwaitParkRef {
  runId: string;
  /** The parked leaf's canonical lexical address (matches parked_run.address). */
  address: string;
  teamId: string;
}

export interface AwaitableCapability {
  /**
   * Live check-now: does this awaited edge currently resolve, and to what?
   * Called at the `await` (continue-inline vs park) and re-called on every
   * resume (re-enter). The engine applies the await's WHERE to `landed`
   * landings; the adapter only reports what has arrived.
   */
  resolveAwait(point: AwaitPoint): Promise<AwaitResolution>;
  /**
   * CORRELATION duty: record the park ↔ watch-point map so an inbound resolution
   * finds the parked run. Idempotent on (runId, address) — a re-parked await
   * re-registers the same row.
   */
  registerAwait(input: AwaitPoint & AwaitParkRef): Promise<void>;
  /**
   * CANCELLATION duty: the one signal (run death ≡ race loss). The REQUIRED
   * response is to drop THIS park's correlation entry — NOT to settle the
   * record (F7: an ask stays answerable, its late answer lands as data).
   */
  dropCorrelation(input: Pick<AwaitParkRef, 'runId' | 'address'>): Promise<void>;
}

/** An adapter that advertises awaitable edges exposes this capability. Absent ⇒
 *  the adapter has no awaitable edges (bare adapters). */
export interface MaybeAwaitable {
  awaitable?: AwaitableCapability;
}
