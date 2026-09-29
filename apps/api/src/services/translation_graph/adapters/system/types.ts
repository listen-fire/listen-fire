// The platform's own events — the vocabulary the `system` adapter, its poll
// source and its handbook chapter all share.
//
// Four kinds, one record shape. Each kind is its own fires edge landing on its
// own node (a listen's parameter is addressed by the node it lands on, so four
// kinds sharing one node would be four listens nobody could tell apart), and
// every node carries the same fields, so a handler written for one reads the
// same way as a handler written for another.

/** Stable adapter identifier — the trigger `kind` of system-derived rows. */
export const SYSTEM_ADAPTER_TYPE = 'system';

/** One platform event kind: its internal type id (lowercase, stable), the
 *  natural name authors see (the edge, the node, AND the `events:` value), the
 *  discrimination tag the poll source stamps, and what an author is told. */
export interface SystemEventKind {
  typeId: string;
  displayName: string;
  tag: string;
  description: string;
}

export const RUN_FAILED: SystemEventKind = {
  typeId: 'run_failed',
  displayName: 'Run Failed',
  tag: 'system:run_failed',
  description:
    'An automation run ended failed. Delivered within a couple of minutes of ' +
    'the run settling; an automation is never told about its own failures, ' +
    'and a rehearsal (dry run) failing is not reported.',
};

/** Kinds declared for the deploy check the next release adds. Declared now so
 *  the surface an author reads is the whole one; nothing emits them yet. */
const NEXT_RELEASE = 'Emitted by the deploy check from the next release; nothing emits it yet.';

export const VALIDATION_ISSUE: SystemEventKind = {
  typeId: 'validation_issue',
  displayName: 'Validation Issue',
  tag: 'system:validation_issue',
  description: `A saved automation stopped validating under a new release. ${NEXT_RELEASE}`,
};

export const DEPRECATED_VERSION: SystemEventKind = {
  typeId: 'deprecated_version',
  displayName: 'Deprecated Version',
  tag: 'system:deprecated_version',
  description: `A saved automation is pinned to a language version the running release deprecates. ${NEXT_RELEASE}`,
};

export const RELEASE_APPLIED: SystemEventKind = {
  typeId: 'release_applied',
  displayName: 'Release Applied',
  tag: 'system:release_applied',
  description: `A new release was deployed and its checks ran over this automation. ${NEXT_RELEASE}`,
};

export const SYSTEM_EVENT_KINDS: readonly SystemEventKind[] = [
  RUN_FAILED,
  VALIDATION_ISSUE,
  DEPRECATED_VERSION,
  RELEASE_APPLIED,
];

/** The `events:` vocabulary — the natural names, exactly as an author writes
 *  them (`listen to sys { events: ["Run Failed"] }`). */
export const SYSTEM_SUBSCRIBABLE_EVENTS: readonly string[] = SYSTEM_EVENT_KINDS.map(
  (k) => k.displayName,
);

/** What every platform event carries — the seeded position's data, keyed by
 *  the internal field ids `describe` declares. */
export interface SystemEventPayload {
  automation: string;
  automationId: string;
  /** Empty when the event concerns no run. */
  runId: string;
  /** The language version's name; empty until versions exist. */
  version: string;
  reason: string;
  url: string;
  /** ISO instant, UTC. */
  at: string;
}
