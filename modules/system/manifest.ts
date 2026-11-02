// The system adapter's manifest: what the host's catalog, handbook and
// checker read about it, construction-free.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { SYSTEM_HANDBOOK_SECTION } from './handbook_section';
import { DEFAULT_KIND, EVENTS_EDGE, KIND_FIELD, SYSTEM_ADAPTER_TYPE } from './types';

export const SYSTEM_MANIFEST: AdapterManifest = {
  adapterType: SYSTEM_ADAPTER_TYPE,
  displayName: 'System',
  description:
    'The host running the program, as a source: a run failed or paused, a wait lost its record, a release was applied. Connect it with ``sys = connect `@lf/system` ``; it needs no credentials. Which kinds of event arrive depends on the host: it reports a kind only if it supplies the facts for it.',
  authoringHints:
    'Every event arrives on `Events`; narrow it by `Kind` (`sys-[e:Events WHERE e.Kind == "Run Failed"]->`). Every event carries `Automation`, `Automation Id`, `Run Id`, `Version`, `Reason`, `Url` and `At`. A program is never told about its own listen’s failures. A kind the host does not report never arrives, so a listen on it stays quiet.',
  handbookSection: SYSTEM_HANDBOOK_SECTION,
  triggerExpectation:
    'Fires on the host’s own events, which it polls: a run of another program ending failed (never a rehearsal), a run paused, a wait whose record was deleted, a listen that could not judge an arrival, a release first run, a saved program with a validation issue or a deprecated language version. The host reports the kinds it has facts for. The first poll sets the mark and emits nothing, so going live never replays past events.',
  supportedTriggers: ['poll'],
  methods: ['listEntryPoints', 'describe', 'getFieldValue'],
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
