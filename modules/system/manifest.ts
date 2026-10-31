// The system adapter's manifest: what the host's catalog, handbook and
// checker read about it, construction-free.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { SYSTEM_HANDBOOK_SECTION } from './handbook_section';
import { DEFAULT_KIND, EVENTS_EDGE, KIND_FIELD, SYSTEM_ADAPTER_TYPE, SYSTEM_EVENT_KINDS } from './types';

export const SYSTEM_MANIFEST: AdapterManifest = {
  adapterType: SYSTEM_ADAPTER_TYPE,
  displayName: 'Listen-Fire',
  description:
    'The host itself, as a source: a run failed or paused, a wait lost its record, a release was applied. Built in; nothing to connect.',
  authoringHints:
    'Every event arrives on `Events`; narrow it by `Kind` (`sys-[e:Events WHERE e.Kind == "Run Failed"]->`). Every event carries `Automation`, `Automation Id`, `Run Id`, `Version`, `Reason`, `Url` and `At`. A program is never told about its own listen’s failures.',
  handbookSection: SYSTEM_HANDBOOK_SECTION,
  triggerExpectation:
    'Fires on the host’s own events, polled every minute by default: a run of another program ending failed (never a rehearsal), a wait whose record was deleted, a release first run. The first poll sets the mark and emits nothing, so going live never replays past events.',
  supportedTriggers: ['poll'],
  methods: ['listEntryPoints', 'describe', 'getFieldValue'],
  subscribableEvents: SYSTEM_EVENT_KINDS.map((kind) => kind.name),
  defaultSubscribedEvents: [DEFAULT_KIND.name],
  // A 0.12 `listen to sys { events: ["Run Failed", "Run Paused"] }` is
  // `listen to sys-[e:Events WHERE e.Kind IN ["Run Failed", "Run Paused"]]->`
  // (`listen-fire upgrade`); one naming no events heard `Run Failed`.
  listenSettingsBecome: {
    path: [EVENTS_EDGE],
    aliases: ['e'],
    paramFrom: DEFAULT_KIND.name,
    keys: { events: { hop: 0, field: KIND_FIELD, op: 'in', absent: DEFAULT_KIND.name } },
  },
  vocabulary: {
    // A built-in owns no brand, but it still owns a mark: a pulse line.
    icon: { d: 'M3 12 H8 L10 7 L14 17 L16 12 H21', fill: false },
    eventPhrase: { default: [{ template: 'When something happens to another program' }] },
  },
};
