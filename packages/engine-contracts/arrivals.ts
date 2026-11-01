// Arrivals (adapter protocol 2.5; 2.6 for root edges, carried parents and
// listens): what lands on a listenable edge, reported by the module that owns it. The host keeps the waiting state: a log of
// arrivals per record's edge, and a wait per run that reads it. The module
// answers two things only. Which key names the edge of each record a run
// waits on (`awaitKeys`), and, with each inbound delivery it reads, what
// arrived on which key (`arrivals` on its acceptance, or the `wake` door).
// No run identity crosses into the module.

/** A record a run waits on: the id its write answered, the data it
 *  carried (Slack keys a thread by the channel in it, not by its id), and its
 *  record type, as the module names it, wherever the host knows it (2.6). A
 *  module whose ids collide across its record types qualifies its keys by it,
 *  in the answer and in each arrival's `key` alike. */
export interface AwaitHead {
  recordId: string;
  headData?: Record<string, unknown>;
  recordType?: string;
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
  /** The fields the module could not read for it (a lookup its provider did
   *  not answer: Slack's channel `Name`, a message's `Mentions App`): a
   *  listen whose filter reads one cannot be judged, and the host reports it
   *  (2.6). Whatever `fields` holds for one is not read by the judge. */
  unknown?: string[];
}

/** One arrival on the edge of the record `key` names. `identity` is the
 *  landing's value of the field the edge declares as its identity; `version`
 *  of its version field. A gone arrival says the record went: nothing more
 *  arrives on its edges. */
export type Arrival =
  | {
      edge: string;
      /** The record whose edge it landed on; absent on one of the
       *  connection's root edges (2.6), which no wait is on. */
      key?: string;
      identity: string;
      version?: string;
      landing: AwaitLanding;
      /** The records it carries from the earlier hops the edge declares
       *  (`carries`), in that order; null for one it cannot carry (2.6). */
      parents?: (AwaitLanding | null)[];
      /** The record the arrival is about, when that is not its landing: a
       *  change to a row names the row (2.6). */
      about?: { recordType: string; externalId: string };
      /** The listen it must not run, by its pipeline (on listen-fire
       *  `listen:<file>:<movement>:<digest>`, the first 8 hex digits of the
       *  sha256 of the listen's identity): its own failure, reported to the
       *  listens on the edge it failed on (2.6). */
      notFor?: string;
      /** The module applied the listen's taken filter before reporting it
       *  (a filtered poll or subscription): the host does not judge it again (2.6). */
      takenApplied?: boolean;
      /** When it happened at its provider (an ISO instant), where the
       *  provider says: a host measures from it whether a run's write caused
       *  it, however late a poll finds it (2.6). */
      occurredAt?: string;
    }
  | { edge: string; key: string; gone: true };

export interface ArrivalsCapability {
  /** The key each head's `edge` is waited on under, in the order of `heads`.
   *  Computed from the heads alone: no call to the system. */
  awaitKeys(input: { edge: string; heads: AwaitHead[] }): Promise<AwaitKey[]>;
}
