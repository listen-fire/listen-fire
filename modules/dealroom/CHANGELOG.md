# @listen-fire/dealroom

## 0.13.0

### Minor Changes

- b12a366: Dealroom funding rounds arrive on the `Funding Rounds` edge, readable and listenable, polled every ten minutes (lf.yaml `pollEvery` overrides it for a connection): ``listen to dealroom-[r:`Funding Rounds` WHERE r.Round IN ["SERIES A"] AND r.`Company Locations` CONTAINS "Germany"]-> fire f``. Each round Dealroom records after the listen began arrives once, with `occurredAt` and `about` the company that raised it; a round corrected afterwards does not arrive again. Two new fields, `Company Industries` and `Company Locations` (the industries, and the cities and countries, of the company that raised), are owned scalars Dealroom judges (`DealroomIndustry`, `DealroomLocation`: its vocabulary has regions a round never lists) and take `contains` and `containsAny` (an OR of CONTAINS, any of several); they and `Round` reach Dealroom's own terms filters, on a walk of `Funding Rounds` as on a listen, and the module judges the rest of the taken filter itself. A walk asks an OR of terms one term at a time, and each round carries the terms it was found by, so the engine's own check of the WHERE agrees; two such conjuncts on one field fail the walk and the listen by name, since Dealroom matches any of a field's terms, never all. A round has an `Id`, its identity. It declares how a 0.12 `listen to dealroom { rounds, industries, hq_locations }`, with `events: ["funding_round"]` or without, becomes this (`listenSettingsBecome`) and no longer declares `listenConfig`, a `fires` edge or event types. Adapter protocol 2.6.

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

- 7cd7476: Each poll event is labelled with its kind, `eventType` `funding_round` (adapter protocol 2.3). Its stated protocol minor is unchanged: an older host routes a labelled event correctly.

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
