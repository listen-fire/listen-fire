# @listen-fire/embed

## 0.14.0

### Minor Changes

- 89f2ee7: `@lf/system` knows an arrival a listen could not judge that is itself one of its `Arrival Not Judged` events by what landed: a landing with that `Kind` on its own `Events`. Before, it matched a prefix of the record id it minted. `SystemRecords`' `UnjudgedArrival` gains `adapter` (the module the arrival came from) and `landing` (what landed, as its module reported it), both `null` when the host kept none; the records door answers both. `@listen-fire/embed`'s `dispatch` answers each `notJudged` with `adapterType` and `landing`: keep them with the fact. The `Event` record programs read is unchanged.

### Patch Changes

- 83543ba: `connect` names the adapter and the credential itself (``gh = connect `@lf/github` using my_github``, `crm = connect #acme_crm using acme` for a module that is no package), with no `import … from adapters` or `from credentials`; the import form is deprecated and still checks under a `0.13` pin. The wasm checks the new form; the handbook, the modules' examples and the authoring MCP's guidance show only it, and the handbook's programs listen to the `manual` and `cron` units by name rather than connecting them.
  
  `@listen-fire/embed`: a module the host registers from a package (`modules: [{ module: slackModule, package: "@lf/slack" }]`) is connected by that package's name, as on every host; the host's own modules are connected as `#` and their adapter type.
- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.13.0

### Minor Changes

- 0b21aae: `awaitKeys` is told each head's record type: `AwaitHead` (and `WireAwaitHead`) gains `recordType?`, the record's type as its module names it, wherever the host knows it (adapter protocol 2.6). The embedder names it for a run's trigger from the arrival's landing. A module whose record types number their ids apart qualifies its keys by it, in its answer and in each arrival's `key` alike. A listen judge's skip may carry a `reason` (`{ skips, reason? }`) when the record it carried for that hop is of another record type.
- 165ade5: `dispatch` answers `{ runs, notJudged }`: beside each run's outcome, every arrival a listen could not judge (`{ program, movement, pipeline, arrival, edge, identity, recordId?, reason, deliveryId }`), the fact listen-fire keeps as `Arrival Not Judged`, so an embedder can alert on it or deliver it again. Before, it was one log line. `dispatch` also refuses a delivery it cannot route, naming why: from a module the host was not given, for a connection the tenant does not hold, with an arrival that does not parse, or with one naming no `key` on an edge that is no root of the module's schema. Before, each ran nothing without a word. A run that ends in its first segment clears the waits its delivery opened (a failed one is torn down), as listen-fire does, so a tick's sweep forgets the later arrivals on those records.
- 522f9cf: The embedded host fires a listen by the check's plan of it. `dispatch(tenant, { adapterType, connection?, arrivals })` takes what a module reports arrived, where it took an event; each arrival runs every saved listen on its module and last edge that hears its connection and whose judge (the engine's, as listen-fire's) says it fires. `SavedProgram.listens` (`ListenPlan[]`) replaces `listeners`. `run` lands an Invocation on the manual unit's `Invocations`. A save refuses, by name, a listen in the retired settings form and one whose earlier hop only listen-fire lists. A listen that states the node its landing is runs only on an arrival that fits it. An arrival the judge cannot decide runs nothing and is said through the new `log` option. `Arrival` is re-exported.
- 6fb0ee9: A delivery is one `dispatch` and one store write, as listen-fire keeps it: its arrivals are logged, each run it starts is a work row, and each such run has its trigger's waits opened from the mark before them, so a later item of the same delivery answers a run's `await new` and the trigger never answers its own; the runs its arrivals woke step on in the same call. `arrive` is gone. A listen runs an arrival once: its receipt is taken in the write that starts its run, so a redelivery runs nothing, and a `Delivery.id` already kept runs nothing at all. A run the call does not start (a failed write, a process that died) stays queued and `tick` starts it once a run lease has passed; `dispatch` throws, naming it, and forgets the delivery's `id` so its sender's retry is kept again. The store's `runHost` must also serve `keepDelivery`, `completeKey`, `forgetDeliveryId` and `startArrivalRun` (`memoryRunHostStore` does). A saved program the host cannot read (saved before 0.13, or pinned to 0.12) runs nothing, said with the remedy, and the others still run; a listen a save would refuse runs nothing when a store holds it all the same, said. Each program is read once by its content.
- 504429a: The run host's store (`runHost`) serves stranded waits (docs/contracts/stranded-waits.md): `waits.log` answers `{ wakes, stranded }`, a gone arrival stranding each wait parked on its record; `waits.open` takes a `null` key, for a record already gone, and a park on such a wait strands it; `waits.arrivals` answers no `gone`; and `waits.stranded` answers one run's stranded waits, or every run's a page at a time. A store an embedder supplies implements them; the in-memory store does. It needs `@listen-fire/engine` 0.13.0.
- 46efd84: A wait the engine opens names the record it waits on: `OpenWait` gains `record_id` (`park.waits.open`'s `recordId`), so a store an embedder supplies can keep it with the wait. A store that answers stranded waits answers it as `recordId`.
- 7b48253: A run that awaits a module's listenable edge parks until something lands there: `arrive(tenant, { adapterType, arrivals })` hands the host what one of the tenant's modules says arrived (adapter protocol 2.5), and each of the tenant's runs waiting on it steps on. `tick` steps runs an arrival woke, runs whose timer is due, and runs that owe a race an earlier step left unsettled. An arrival no run waits on yet is kept for an hour, for a run that starts waiting on its record. A step whose last write finds the run taken over by another process leaves the run parked, and its row retries for the run's next holder; a row for a run no longer parked steps nothing. Where a run stands is now its run row in the store's `runHost` (which must also serve `RunRowStore`: `startRun`, `runStatus`), not `EmbeddedRun.status`: a park marks its run parked, and the step that ends a run settles it, each in the same write. It needs `@listen-fire/engine` and `@listen-fire/engine-contracts` 0.13.0 (the run host's waits).

### Patch Changes

- 043aa21: An embedder's catalog build refuses, in an error that names it, a module whose references or entry points declare how a listen reads them in a way that cannot mean what it says (an unknown `delivery`, a polled edge without `pollEverySeconds`, `bounded: false` without `boundedBy`, a `carries` hop that is not there, a `membersChange` that is neither `"pushed"` nor `{ relistEverySeconds }`), and a field of kind `owned` that names no scalar. Such a module used to build a catalog; now `introspectAdapter` throws.
- 16e3776: A run that ends in its first segment leaves no wait behind: the embedded host clears a quiescent run's state and tears a failed one's down, as listen-fire does, where it settled the run row only. A listen reads its connection's schema as listen-fire instantiates it, at the entry position its construction pins (else its unpositioned one, never another credential's), so a connection pinned to a position judges its arrivals by its field ids.
- 80e90e6: A `tick` never forgets an arrival a run that is starting is about to read. A run the host starts takes no lease, so each step now holds the arrival mark it took as it began until it ends, and the sweep keeps every arrival above the lowest mark held.
- eb466a2: `tick` first forgets the arrivals no run awaits (the run host's `sweepArrivals`), so the log does not grow without end. Each arrival's identity is kept for its module's re-send window (`resendWindowSeconds`, an hour when the module declares none), so a re-send of an arrival already forgotten is still a repeat that wakes nothing.
- 35e92b3: A listen's WHERE reads an arrival's fields by the names the program writes, as its run does, also where a module keys its records by its own field ids. The catalog's position carries `fieldIds` (name → id, where the two differ), and each host reads every record an arrival carries by those names before judging it (`named_fields` in Rust, `namedFields`/`namedArrival` in TypeScript, held by both to `conformance/listen-field-names.json`). So `inbox-[e:Emails WHERE e.Subject CONTAINS "Series A"]->` fires: before, an email listen reading any field but `Key` never fired, and nothing said so. An email's arrival also carries its derived `Body`.
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

## 0.12.8

### Patch Changes

- 1e44cfd: A new package, `@listen-fire/embed`: the engine embedded in another product's process as one host. `createEmbeddedHost({ modules, store?, secrets?, engine?, limits?, now?, moduleHost? })` connects a tenant's modules under the names its movements import (`connect(tenant, { name, module, credential })`, each module loaded in process over that tenant's credential); `save` checks a movement against the tenant's catalog, built from its connections and kept until they change or `schemaChanged(tenant)` is called; `dispatch(tenant, { adapterType, connection?, event })` runs every listen that hears the event, narrowed by connection as `lf` routes; `tick(now?)` steps on parked runs whose timer is due. `run(tenant, { program, text? })` runs one program now: every `listen to manual` it declares fires, `text` its Invocation's `Text`; the run host's `manual` unit is in every tenant's catalog, as `lf` builds it in, unless a module of that adapter type replaces it. Its store (connections, saved movements, run records, the run host's store) and its vault are the embedder's, in memory by default. It takes `@listen-fire/engine` as a peer (`>=0.12.0 <1.0.0`). This is the package's first release: `changeset version` takes it from 0.12.7 to 0.12.8.
