# @listen-fire/system

## 0.14.0

### Minor Changes

- 89f2ee7: `@lf/system` knows an arrival a listen could not judge that is itself one of its `Arrival Not Judged` events by what landed: a landing with that `Kind` on its own `Events`. Before, it matched a prefix of the record id it minted. `SystemRecords`' `UnjudgedArrival` gains `adapter` (the module the arrival came from) and `landing` (what landed, as its module reported it), both `null` when the host kept none; the records door answers both. `@listen-fire/embed`'s `dispatch` answers each `notJudged` with `adapterType` and `landing`: keep them with the fact. The `Event` record programs read is unchanged.
- 758185b: `Validation Issue` and `Deprecated Version` have a reader. `SystemRecords` gains the optional `validationIssues` and `deprecatedVersions` (each `({ after: { at, automationId }, limit }) => ProgramNotice[]`, oldest first: the program, the version involved, the reason, when it was found, an optional URL), and the poll keeps a mark per kind in its cursor. A host without them reports neither kind, as before; listen-fire supplies none, so its own records are unchanged. lf-platform's deploy check supplies both (docs/contracts/system-events.md).

### Patch Changes

- 83543ba: `connect` names the adapter and the credential itself (``gh = connect `@lf/github` using my_github``, `crm = connect #acme_crm using acme` for a module that is no package), with no `import … from adapters` or `from credentials`; the import form is deprecated and still checks under a `0.13` pin. The wasm checks the new form; the handbook, the modules' examples and the authoring MCP's guidance show only it, and the handbook's programs listen to the `manual` and `cron` units by name rather than connecting them.
  
  `@listen-fire/embed`: a module the host registers from a package (`modules: [{ module: slackModule, package: "@lf/slack" }]`) is connected by that package's name, as on every host; the host's own modules are connected as `#` and their adapter type.
- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.13.0

### Minor Changes

- a4c89c5: `Arrival Not Judged` names its attempt: the new `Attempt` field (a number, 0 on every other kind) is 0 for the arrival's first judging and one more for each `listen-fire listens replay` that still cannot judge it, and the `Event Id` is `arrival_not_judged:<listen>:<arrival>:<attempt>`, so each failed attempt is reported once. `UnjudgedArrival` and its cursor mark carry `attempt`; a host that sends none is read as attempt 0. An arrival that is itself an `Arrival Not Judged` event is never reported in turn (the module logs it), so two listens on `Events` cannot report each other without end (docs/contracts/system-events.md).
- 0206064: `Arrival Not Judged`: a listen that could not tell whether an arrival fires it (its filter reads a field the module could not read) is reported once per listen and arrival, with the new `Listen`, `Delivery Id` and `Arrival Id` fields, `notFor` that listen. `SystemRecords` gains `unjudgedArrivals`, read over listen-fire's records door as `records.unjudgedArrivals` (docs/contracts/system-events.md).
- 46efd84: `@lf/system`, a new module: the host itself as a source. One listenable `Events` edge, polled, whose `Event` a listen narrows by `Kind` (`Run Failed`, `Run Paused`, `Validation Issue`, `Deprecated Version`, `Release Applied`, `Wait Lost Its Record`, `Arrival Not Judged`), which the module takes. Each event about a run is `notFor` that run's own listen and `about` the run, so a host's loop breaker caps a chain of failure handlers. listen-fire hands it its facts over the records door (`systemModule`); another host hands in its own (`systemModuleWith`). See docs/contracts/system-events.md.

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
