// The host's own events: the vocabulary `@lf/system`'s adapter, its poll and
// its handbook section share (docs/contracts/system-events.md).
//
// One edge, `Events`, lands on one record, `Event`; its `Kind` says which of
// the six things happened. Every event carries the same fields, so a handler
// written for one kind reads the same way as one written for another, and a
// listen names the kinds it wants with a WHERE the module takes:
// `sys-[e:Events WHERE e.Kind IN ["Run Failed", "Wait Lost Its Record"]]->`.

/** The adapter type: what a program's `connect` of `@lf/system` names. */
export const SYSTEM_ADAPTER_TYPE = 'system';

/** The root edge every event arrives on, and the record it lands on. */
export const EVENTS_EDGE = 'Events';
export const EVENT_TYPE = 'Event';

/** The field a listen narrows the kinds by. */
export const KIND_FIELD = 'Kind';

/** One kind of event: its name (the `Kind` an author writes) and what an
 *  author is told of it. */
export interface SystemEventKind {
  name: string;
  /** The stable lowercase id an event's id starts with. */
  id: string;
  description: string;
}

export const RUN_FAILED: SystemEventKind = {
  name: 'Run Failed',
  id: 'run_failed',
  description:
    'A run ended failed. A program is never told about the failures of its own listen, and a rehearsal (a dry run) failing is not reported.',
};

export const RUN_PAUSED: SystemEventKind = {
  name: 'Run Paused',
  id: 'run_paused',
  description:
    'A run paused at its cost limit, and stays paused until someone resumes it. `Reason` says what it spent and the limit. A host that fails a run at its cost limit instead (listen-fire) never reports one.',
};

export const VALIDATION_ISSUE: SystemEventKind = {
  name: 'Validation Issue',
  id: 'validation_issue',
  description:
    'A saved program does not validate cleanly under the running release, so it cannot be upgraded to it yet. `Reason` lists what to repair. A host that refuses to run a program that does not check (listen-fire) never reports one.',
};

export const DEPRECATED_VERSION: SystemEventKind = {
  name: 'Deprecated Version',
  id: 'deprecated_version',
  description:
    'A saved program is written in a language version the running release deprecates; it still runs. A host that refuses to run a program that does not check (listen-fire) never reports one.',
};

export const RELEASE_APPLIED: SystemEventKind = {
  name: 'Release Applied',
  id: 'release_applied',
  description: 'A new release is running. `Version` names it. Not about one program: `Automation` and `Run Id` are empty.',
};

export const WAIT_LOST_ITS_RECORD: SystemEventKind = {
  name: 'Wait Lost Its Record',
  id: 'wait_lost_its_record',
  description:
    'A run waits on a record that was deleted, so nothing will ever arrive on its wait (docs/contracts/stranded-waits.md). `Adapter`, `Edge` and `Record Id` say which wait; a `race` with a `sleep` is the way out. A program is never told about its own listen\'s waits.',
};

export const SYSTEM_EVENT_KINDS: readonly SystemEventKind[] = [RUN_FAILED, RUN_PAUSED, VALIDATION_ISSUE, DEPRECATED_VERSION, RELEASE_APPLIED, WAIT_LOST_ITS_RECORD];

/** What `Kind` an omitted kind means in a 0.12 listen (`listen to sys {}`). */
export const DEFAULT_KIND = RUN_FAILED;

/** Every event's fields, as their names: what a landing carries. */
export interface SystemEventFields {
  'Event Id': string;
  Kind: string;
  Automation: string;
  'Automation Id': string;
  /** Empty when the event concerns no run. */
  'Run Id': string;
  /** The release's version; empty when the event concerns none. */
  Version: string;
  Reason: string;
  /** A link to where a person sees it; empty where the host has no such page. */
  Url: string;
  /** ISO instant, UTC. */
  At: string;
  /** For a wait that lost its record: the module its record is in; else empty. */
  Adapter: string;
  Edge: string;
  'Record Id': string;
}

/** The fields' declarations, in the order a handler reads them. */
export const SYSTEM_EVENT_FIELDS: ReadonlyArray<{ name: keyof SystemEventFields; kind: 'string' | 'date' | 'enum'; description: string }> = [
  { name: 'Event Id', kind: 'string', description: 'Names the event: the same on every poll that finds it.' },
  { name: 'Kind', kind: 'enum', description: 'Which thing happened. A listen names the kinds it wants: `e.Kind == "Run Failed"`, or `e.Kind IN [...]`.' },
  { name: 'Automation', kind: 'string', description: 'The program the event is about (its movement); empty when it concerns none.' },
  { name: 'Automation Id', kind: 'string', description: 'That program’s id (on listen-fire, `<file>:<movement>`).' },
  { name: 'Run Id', kind: 'string', description: 'The run the event is about; empty when it concerns none.' },
  { name: 'Version', kind: 'string', description: 'The release involved; empty when none is.' },
  { name: 'Reason', kind: 'string', description: 'What happened, in words: for a failed run, why it failed.' },
  { name: 'Url', kind: 'string', description: 'A link to where a person sees it; empty where the host has no such page.' },
  { name: 'At', kind: 'date', description: 'When it happened (UTC).' },
  { name: 'Adapter', kind: 'string', description: 'For a wait that lost its record: the module its record is in. Empty on every other kind.' },
  { name: 'Edge', kind: 'string', description: 'For a wait that lost its record: the edge it waits on. Empty on every other kind.' },
  { name: 'Record Id', kind: 'string', description: 'For a wait that lost its record: the deleted record’s id. Empty on every other kind.' },
];
