# @listen-fire/granola

## 0.13.0

### Minor Changes

- 1d7a03c: Granola meeting notes arrive on the connection's `Meetings` edge, readable and listenable, polled every five minutes (lf.yaml `pollEvery` overrides it for a connection): `listen to granola-[n:Meetings WHERE n.Folders CONTAINS "deals"]-> fire f`. Each note new or changed since the last poll arrives once, versioned by its `Updated At`, with `occurredAt`. A new field, `Folders`, lists the folders a note is in by name, lowercased, and takes `CONTAINS`; the module applies the taken filter itself. It declares how a 0.12 `listen to granola { folder: "Deals" }` becomes it (`listenSettingsBecome`, the folder lowercased as 0.12 compared it) and no longer declares `listenConfig`, a `fires` edge or event types. Adapter protocol 2.6.

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

- 7cd7476: Each poll event is labelled with its kind, `eventType` `note` (adapter protocol 2.3). Its stated protocol minor is unchanged: an older host routes a labelled event correctly.

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
