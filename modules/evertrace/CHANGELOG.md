# @listen-fire/evertrace

## 0.13.0

### Minor Changes

- 55ff68c: Evertrace arrives on two listenable edges, each polled every five minutes (lf.yaml `pollEvery` overrides it for a connection) with its own cursor: `Signals`, the edge past signals are read along (``listen to evertrace-[s:Signals WHERE s.`Saved Search` == "Stealth in Europe"]-> fire f``), and `List Entries`, which lands a `List Entry` each time a signal is added to a list (``listen to evertrace-[e:`List Entries` WHERE e.`List Name` == "Pipeline"]-> fire f``). An arrival carries `occurredAt`; an entry is `about` its signal. New fields: `Saved Search` on a signal (an owned `EvertraceSavedSearch`, a saved search by title or id; the module reads the search and judges the rest of the taken filter itself, and a walk of `Signals` reads through it too, each signal carrying the search it was found by) and `List Name` (an owned `EvertraceListName`, by name or id, choosing the lists read) and `List Id` on a list entry. A signal and a list entry each have an `Id`, its identity. It declares how a 0.12 `listen to evertrace { search }` and `{ events: ["list_entry"], list }` become these (`listenSettingsBecome`, chosen by the event named; one naming both events has no rewrite) and no longer declares `listenConfig`, `fires` edges or event types. Adapter protocol 2.6.

### Patch Changes

- 16e3776: A module's `poll` takes an edge's input alone (`PollEdgeInput`) and answers its arrivals (`PollEdgeAnswer`); `PollInput` and `PollAnswer` are gone from the kit, and a 0.12 settings poll's input reaches no module. Dealroom, Evertrace, GitHub, Gmail, Granola and System no longer refuse that input themselves. The in-process `Adapter.ensureEventSubscription` takes an edge's subscription; removing and refreshing one still take a 0.12 settings listen's webhook, so a host can remove it.
- Updated dependencies [4c09d6a]
- Updated dependencies [faa7050]
- Updated dependencies [acec0bd]
- Updated dependencies [301dab3]
- Updated dependencies [3c2774e]
- Updated dependencies [dd81bed]
- Updated dependencies [c4af6cc]
- Updated dependencies [a942076]
- Updated dependencies [46efd84]
- Updated dependencies [9520af9]
- Updated dependencies [9e9316c]
- Updated dependencies [5bfc3f2]
- Updated dependencies [66d32d5]
- Updated dependencies [16e3776]
- Updated dependencies [16e3776]
- Updated dependencies [da1a05b]
- Updated dependencies [abc777e]
- Updated dependencies [ad23b9c]
  - @listen-fire/module-kit@0.13.0

## 0.12.7

### Patch Changes

- 7cd7476: Each poll event is labelled with its kind, `eventType` `signal` or `list_entry` (adapter protocol 2.3). Its stated protocol minor is unchanged: an older host routes a labelled event correctly.

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
