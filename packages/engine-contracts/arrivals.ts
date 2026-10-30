// Arrivals (adapter protocol 2.5): what lands on a listenable edge, reported
// by the module that owns it. The host keeps the waiting state: a log of
// arrivals per record's edge, and a wait per run that reads it. The module
// answers two things only. Which key names the edge of each record a run
// waits on (`awaitKeys`), and, with each inbound delivery it reads, what
// arrived on which key (`arrivals` on its acceptance, or the `wake` door).
// No run identity crosses into the module.

/** A record a run waits on: the id its write answered, and the data it
 *  carried (Slack keys a thread by the channel in it, not by its id). */
export interface AwaitHead {
  recordId: string;
  headData?: Record<string, unknown>;
}

/** The key one head's edge is waited on under, or the record is gone and
 *  nothing more arrives on it. */
export type AwaitKey = { key: string } | { gone: true };

/** One landing along a listenable edge. Its `fields` are read back through
 *  the module's own `getFieldValue` for `recordType`. */
export interface AwaitLanding {
  recordId?: string;
  recordType?: string;
  fields: Record<string, unknown>;
}

/** One arrival on the edge of the record `key` names. `identity` is the
 *  landing's value of the field the edge declares as its identity; `version`
 *  of its version field. A gone arrival says the record went: nothing more
 *  arrives on its edges. */
export type Arrival =
  | { edge: string; key: string; identity: string; version?: string; landing: AwaitLanding }
  | { edge: string; key: string; gone: true };

export interface ArrivalsCapability {
  /** The key each head's `edge` is waited on under, in the order of `heads`.
   *  Computed from the heads alone: no call to the system. */
  awaitKeys(input: { edge: string; heads: AwaitHead[] }): Promise<AwaitKey[]>;
}
