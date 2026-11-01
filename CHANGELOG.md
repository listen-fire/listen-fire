# Changelog

Every pull request that changes what an author writes, or what a `listen-fire` user sees, adds a line under
Unreleased in the same pull request. Tagging a release moves the Unreleased entries under a heading
for the new version, with the date. When a new minor line is cut, move the previous minor's sections
(with their link references) into `docs/changelog/v0.N.md` and list it under Earlier releases.

This file is the language's changelog: the core (the parser, checker, language and engine crates, `listen-fire`, and the `movement-lang`, `engine` and `engine-contracts` packages, which share the language's one version). Every other package (the modules, `module-kit`, `module-runtime`, the helpers) and the `module-wire` and `module-kit` crates keep a `CHANGELOG.md` of their own from 0.12.6; their earlier entries are here.

This file is shared history. Up to the split into two repositories (0.12.0) it was one file for two
audiences, an operator running a self-hosted installation and an author writing automations in the
movement language, and both repositories keep it in full. From the split on, this repository's
Unreleased section takes only the language's entries (constructs, the checker, the engine, `listen-fire`,
modules, the docs); the platform's entries live in `lf-platform`'s `CHANGELOG.md`. This repository
is versioned by its release; the entry for a break names the release that introduces it and which older pins it no longer reads.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the git tags
named in [`RELEASING.md`](RELEASING.md).

## [Unreleased]

<!-- add merged PRs here -->

### 0.13.0

A new compatibility key: waiting becomes a traversal, and callbacks retire.

- **What changed.** An answer from outside arrives on an edge its module declares `listenable`: a press on a message's `Interactions`, a form's answer on its `Submissions`, a reply on a thread's `Replies`. A run waits for one with `await x-[:E]->`, or `await new x-[:E]->` for one that arrives from now. `callback(…)` is retired for buttons on a message and forms from the new `@lf/forms`; `await first(x)` is written `await x`; a wait's `WHERE` keeps the values it read from the run.
- **Why.** A callback was a second way for a run to wait, outside the graph, with its own ids, URLs and host machinery. As edges, answers get what every traversal gets: typed fields, a checked `WHERE`, and the checker's diagnostics.
- **Which pins it reads.** `0.13.x` only. A project or an automation pinned to `0.12.x` is refused by name ("validate it under 0.13.0 and upgrade it"). A change that alters what a construct means says so in its own entry below and in a checker diagnostic under a `0.13` pin.
- **To upgrade.** Replace each `callback(…)` by hand (`MOV_CALLBACK_RETIRED` names the replacement). Then run `listen-fire upgrade`: it respells `await first(…)`, lists each wait whose `WHERE` now captures a value, and moves the pin to `0.13.0` once every file checks clean. Let runs parked under 0.12 finish first: a 0.13 engine cannot resume them. Store modules and embedders: see "Removed" and the store slot's new `waits.*` and `parks.commitSegment`. The guide is [docs/language/migrating-to-0.13.md](docs/language/migrating-to-0.13.md).

#### Changed

- `cron`, `manual`, `@lf/email` and `@lf/webhook` are listened to as edges (`listen-fire upgrade` rewrites each 0.12 listen):
  - `cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1-5" AND t.Zone == "Europe/London"]->`: a tick per occurrence of each schedule and zone named (`==`, `IN`, or an `OR` of `==`). A listen naming no zone ticks in UTC. Two listens on one schedule and zone share one clock: the cron unit's `Ticks` is a polled edge (`pollEverySeconds: 60`, overridden per connection by `pollEvery: { cron: … }` in lf.yaml), and its ticks are its shared poll's `poll_edge` rows. `listen-fire drain --kinds cron` is refused by name: name `poll_edge`.
    - Each poll fires every occurrence since the last one: a minutely schedule polled every five minutes fires five ticks a poll. Occurrences older than one poll interval were missed while nothing polled; of those only the latest fires, once.
    - A tick fires up to one poll interval late (60 seconds by default), where it fired within a second in 0.12.
    - One listen fires once per instant, however many spellings of a schedule or zone it names (`IN ["0 9 * * 1-5", "0 9 * * MON-FRI"]`).
    - A zone is read as the checker reads it, offsets (`+01:00`) included. A schedule or zone the clock cannot read fires nothing and prints a line each poll naming it; the others the listen names still fire.
    - The first upgrade from 0.12 skips one catch-up: 0.12's per-listen cron checkpoints are not carried to the shared poll, whose first poll only arms. An occurrence missed while the upgrade ran does not fire.
  - `manual-[:Invocations]->`: `listen-fire run <movement>` is an arrival on it, to the listens that fire the movement.
  - `inbox-[e:Emails WHERE e.Key == "deals"]->`: each message arrives on `Emails` with the plus-suffix it was sent to as its `Key`, lowercased. A listen names the keys it takes; mail no listen names runs nothing, and a line says so with its key. Mail sent to the box itself has the empty key: `inbox-[e:Emails WHERE e.Key == ""]->` hears it. A key may hold any character an address's plus-suffix can (`deals_q3`, `q3.deals`), lowercase. A plus-suffix with a non-ASCII character (an internationalised address) matched in 0.12 and has no spelling in 0.13: `InboxKey` is ASCII.
    - The upgrade rewrites a 0.12 listen with no key to `e.Key == ""`, and a key written in capitals lowercased (`{ key: "Deals" }` becomes `e.Key == "deals"`), as 0.12 compared keys without case.
  - `hooks-[:Requests]-><Payment>`: each delivery arrives on `Requests`, its body untyped JSON, and the listen states the node it is. A delivery that fits no stated node is answered 400, naming the fields, and runs nothing; one that fits another listen's node runs only that listen.
- `@lf/github` is listened to on its `Notifications` edge, polled every minute (`pollEvery` in lf.yaml overrides it for a connection): `gh-[n:Notifications WHERE n.Reason IN ["mention", "assign"]]->`. A 0.12 `{ events, participating }` becomes `n.Reason IN [...]` and `n.Participating == true` (`listen-fire upgrade`). Listens on one connection with the same `WHERE` share one poll. A reason GitHub never sends is a warning where it is written (`MOV_ENUM_UNKNOWN_VALUE`), where a 0.12 `events` value was an error.
- `listen-fire run --event` takes an event file of arrivals (`{ "external": "cron", "event": { "arrivals": [ … ] } }`), judged against the traversal listens on their edges as a delivery is. One arrival runs a listen once, however often it is handed over. `--dry-run` refuses such a file.
- The judge of an arrival compares an owned field the arrival carries (a tick's `Schedule`, a message's `Key`) as the text it is; it is undecided only on one the arrival does not carry.
- An arrival fires a listen only when what landed, and each record it carries for an earlier hop, is of the record type the listen's hop lands on. Before, a listen was matched by its last edge's name alone: one edge name hangs off several record types (every `@lf/stripe` object's `Changes`), so `listen to pay-[:Customers]->-[c:Changes WHERE c.Kind == "created"]-> fire welcome` also fired on an invoice's `invoice.created`, its `CustomerChange` parameter bound to an invoice's change.
  - A record of another type skips the listen. An arrival whose landing or carried parent states no `recordType` runs no listen, and the host says why: a module states each one's record type as it describes it (adapter protocol 2.6). Every bundled module, `cron` and `manual` already did.
  - A module whose one listenable edge name lands on the same record type from two record types is refused when `listen-fire` describes it, naming the edge: its arrivals could not be told apart.
  - The judge's input (`judge_arrival` in the wasm, `PlanArrival` in `engine-contracts`) takes each record as `{ recordType?, fields }` where it took the fields alone; `listen-arrivals.json` gains the cases. For `lf-platform`: pass each arrival's `landing` and `parents` through with their `recordType` (`listenFires` in `@listen-fire/engine` does), and expect a describe of an installed module to be refused when it declares such an edge.
  - A skip because of record type says so: the judge's verdict is `{ skips: n, reason }`, where it was `{ skips: n }` for every skip, and `listen-fire`'s debug line gives the reason rather than "does not match the WHERE". A skip by a `WHERE` is `{ skips: n }` as before.
  - A wait is keyed by record type too, where a module needs it. `awaitKeys` is told each head's `recordType` (adapter protocol 2.6; `AwaitHead.recordType`, optional), and `@lf/affinity` keys a record's `Changes` by its kind and id, in its answer and its arrivals alike (`organization:13`). Why: Affinity numbers organizations, persons, opportunities and list entries apart, so a wait on organization 13's `Changes` was answered by person 13's change. Stripe's ids carry their object's prefix and Attio's are UUIDs, so their keys are unchanged.
  - For `lf-platform`: pass each head's `recordType` to `awaitKeys` (`@listen-fire/embed` and the engine do), and read a skip's optional `reason`.
  - A delivery is no longer refused for misfitting the stated node of a listen on another record type's edge of the same name: that listen skips it.
- An arrival every listen on its edge skips by its `WHERE` prints one line on an edge whose module declares `addressed` (email: mail goes to a key its sender chose), and under `LF_LOG=debug` on any other; the line gives its values of the owned fields those `WHERE`s compare (`email: the arrival … on Emails (its Key is "deal") matches the WHERE of no listen on it: it runs nothing`). A delivery that fits a listen's stated node prints nothing of the listens whose node it does not fit; one that fits none still names each.
- `listen-fire run <movement>` says when an invocation does not match a listen's `WHERE`, and `--dry-run` rehearses only the listens it matches.
- `listen-fire` refuses to serve a project that fails `listen-fire check`: any check error, not a warning, stops `serve` (with `--doors-only` too), `drain`, `run --webhook` and `resume` with no run id.
  - The refusal prints each error as `listen-fire check` does (file, line, column, code and message), then a line saying to run `listen-fire check`.
  - Under a running `serve` or `drain`, an edit that leaves any check error is refused and the running files keep serving. Before, an edit was refused only when it raised a file's count of errors, so a project that already had errors went on serving them.
  - `run <function>`, `run --event`, `run --poll`, `runs rerun` and `resume <run>` still open a project with check errors (a run of a function in a file that does not check is refused by the engine, as before).
  - Why: a project served in part routes some deliveries and silently drops others; a refusal at the start says which files to fix.
- A module declares what each edge offers for listening with `listenable: true` on the reference, in place of `awaitable` and `watchable`.
  - Every module set the two retired keys together.
  - `readable` still says whether the edge can be listed, so an edge may be listenable, listable, or both.
  - Three optional keys describe arrivals: `identity` (the field of what lands that names an arrival), `version` (the field that changes when an arrival changes) and `cursor` (whether the module can list arrivals since a mark it hands out).
  - `identity` and `version` must name a field the landing's type declares, or `listen-fire` refuses the module, naming the field and what the landing declares.
  - `@lf/slack`'s `Replies` declares `listenable` and no `identity`: a reply's record id (its channel and `ts`) names it, listed or announced.
  - A module that still declares `awaitable` or `watchable` on a reference is refused when `listen-fire` describes it, naming `listenable`.
  - `resolvesEmpty` is retired too: a deleted record leaves the wait waiting on every edge, so a module has nothing to declare. A reference that declares it is refused when `listen-fire` describes the module, saying so; `@lf/slack`, the example CRM and the catalog snapshot no longer carry it, and the story analysis's awaited traversal no longer reports it.
  - The catalog snapshot contract moves to version 2, since a member was removed. Version 1 is still read, and deprecated. A snapshot of either version that still carries `awaitable`, `watchable` or `resolvesEmpty` is refused by both readers.
  - Why: an edge's two capabilities, being listed and announcing arrivals, are separate facts, and the two retired keys only ever said the second one twice.
- The story analysis moves to version 2: its awaited traversal says `listenable` where it said `awaitable`, the catalog's word since 0.13.0, and a renamed member bumps the version. A listen on a traversal carries its `path` (docs/contracts/story-analysis.md). Version 1 is still read, its `awaitable` read as `listenable`, and deprecated.
- `await x-[:E]->` waits for one record on an edge its module announces arrivals on (`listenable`), and `await new x-[:E]->` waits only for one that arrives after `x` entered the run.
  - A run started by a delivery reached its trigger, and each record its trigger's arrival carries (an Attio change carries its deal), at that delivery. So `await new` on one of them counts from the delivery: a second change of the deal in the same delivery answers `await new d-[:Changes]->`, and the change that started the run never does. A record the run walks to that its arrival did not carry (the deal's company) counts from the walk. Why: the run has reached its triggering event before it starts, and a delivery's other items about the same record are part of what happened.
  - A plain `await` takes the first match already on the edge, in the edge's declared order, or else the first to arrive. On an edge that can be listed but declares no order, it is refused (`MOV_AWAIT_UNORDERED`): write `await new`.
  - `await first(…)` is retired: `MOV_V5_SPELLING` respells it `await <traversal>`, a safe fix `listen-fire upgrade` applies. It waits for the same one record.
  - Awaiting an edge that announces nothing (`MOV_AWAIT_NOT_AWAITABLE`) suggests a read, or an `await until(…)` on the condition.
  - Awaiting a walk of more than one edge is refused (`MOV_AWAIT_BARE_WALK`): bind the record the last edge leaves from, then await that edge off it.
  - Reading an edge that can only announce, outside a wait, is refused as before (`MOV_AWAIT_REQUIRED`); its message now shows the wait to write.
  - A name called `new` is still a root: `await new-[:Notes]->` waits on the record `new` holds.
  - Why: a wait is one record off a listenable edge, so the bare traversal says it; `first(…)` said it twice.
- The handbook teaches waiting as traversal. Its reviews chapter covers waiting on a person, `await` and `await new`, buttons, form links (`host-links`), a deleted record ending a wait, and captured values; every wait it shows on a person or a system, in a chapter or a module's section, sits in a `race` with a `sleep`, and its tests hold that. The Slack, Telegram and WhatsApp module sections write their waits as `await x-[:E]->`. A chapter that teaches `callback(…)` or `await first(…)` breaks the handbook's prose contract. `MOV_CALLBACK_RETIRED`, `MOV_AWAIT_UNORDERED` and `MOV_AWAIT_VALUE_CAPTURED` end with a pointer to the reviews section that shows the fix (`reviews#waiting-on-a-person`, `reviews#await-and-await-new`, `reviews#captured-values`).
- A wait's `WHERE` reads a field of a record from the run (`founder.Email` in `await m-[x:Replies WHERE x.From == founder.Email]->`) once, when the wait is reached. Under a 0.12 pin it was read again at every check, so a change to that record while the run waited changed what the wait accepted.
  - What the `WHERE` reads from a system, such as a walk off a connection, is still read at every check.
  - `listen-fire upgrade` from a 0.12 pin lists each such wait as a warning (`MOV_AWAIT_VALUE_CAPTURED`), naming the fields read.
  - There is nothing to rewrite, so the warning does not hold the pin: the pin still moves to `0.13.0`.
  - A wait that should follow the live value tests it after the wait, against `refresh(founder)`.
  - Why: a wait keeps the values it was written with, as a closure keeps what it closed over; it does not fetch them again while it waits.
- An `await` on a module's edge is answered by `listen-fire`'s own log of what arrived, not by asking the module.
  - The run opens the wait when the awaited record enters it: just before the write that makes it, as it is read, at a block's head, or as a function's or a closure's parameter (marked before the call reads its arguments, or a `map` its members). An answer that lands while the write or the read is still running counts. A `map` member that starts only after the run parked and resumed waits from the mark the `map` took before it first read its members.
  - A plain `await` on an edge that can be listed takes the first match the listing holds; else, and for `await new`, the first arrival since the record entered that its `WHERE` takes. Two arrivals in one wake resume the run once, binding the first. Two plain `await`s on one record's edge share its wait, and both take the listing's first match.
  - An arrival that names its record is bound as that record, as the listing would have bound it, so a walk, a write or another `await` off it works however it came.
  - A record deleted while a run waits on it leaves the wait waiting; race every wait on a person or a system with a `sleep`.
    - A wait whose record is deleted never resolves, on every module: many systems cannot say a record went, so none is relied on to. What follows the `await` never runs, and the run stays parked. A `race` arm on such a wait never settles, as a promise that never resolves loses a race, so a `sleep` beside it takes the race.
    - The same holds when the record is deleted before the wait opens, and in an `all` arm or a `map` member, whose combinator or op then never finishes.
    - Store modules: a gone arrival wakes no wait. `waits.log` answers no wait for it, and `parks.commitSegment` queues no wake for a wait whose record is gone (docs/contracts/store-slot.md).
    - The wait is marked stranded, and `listen-fire runs` shows it (below, under Added). A record already gone when its wait would open gets a wait all the same, opened without a key, so the run parks on it and is shown stranded the same way.
    - Why: before, the wait settled empty and the code after it was skipped, which only modules that report deletion could do; a program then behaved one way on one module and another way on the next.
  - So what an `await` binds is never absent where it is read: the check types it present, and a walk off it needs no `if (x == null)` guard. Before, such an edge's `await` was typed maybe absent, and an unguarded walk was refused (`MOV_ABSENT_REQUIRED`) though the guard could never run.
  - What a function that awaits a record answers a combinator, a collection op or its caller is what it returns: an `all` slot, a `map` member and a call's result are typed present, as for a function that does not wait.
  - A run started by a delivery waits on its trigger record from the delivery's mark, so what arrived while the run was starting counts, and the delivery's own arrivals never answer it.
  - An await that loses a `race` to a `sleep` wakes nothing when its answer comes later.
  - Each stretch of a run between two parks keeps its progress in one write when it parks or ends: where it parked, what its `all`, `race` and `map` wait on, the end of the wait it resumed, and whether the run is now parked, completed or failed. A run whose worker dies before that write has moved nowhere: the wake is tried again, resumes the same leaf, and runs on as though nothing happened. An arrival a resumed run took is kept as taken in that same write, so a run that dies first reads the arrival again. A run that has lost its lease to another worker takes no arrival.
    - A resume that goes another way on its retry than it did before its worker died (an adapter read answers differently, so a branch that finished the first time parks the second) fails the run: `the run's replay diverged from its first attempt at <address>…`. Before, such a run stayed parked forever.
    - A `race` arm that wins after the run parked leaves the race to its run to settle, owed in that same write as a `settle_race` work row. The step that settles the race, and runs the code after it, deletes the row in its own write, and a run is never completed while it owes a race. Why: before, the race was owed only in the worker's memory. A worker that died between the arm's write and the race's settling left the run parked with nothing to wake it, or let a later arm complete the run without the code after the race having run. And when every arm resumed at once, the last arm's write completed the run before that code ran. `listen-fire drain --kinds` takes `settle_race`.
    - Store modules: a new method, `parks.commitSegment`, keeps that stretch's joins, its parks, the end of the leaf it resumed, the run's settle (as `runs.settle` takes it), the races it owes (`owedRaces`) and the race it settled (`settledRace`) in one fenced write, and in that write queues a wake for each wait it parks whose arrivals are unread. listen-fire calls it at the end of every stretch that parked, recorded a join, resumed a leaf or settled a race. Of the other stretches, one that settles its run does so with `runs.settle` alone, and one that leaves its run as it stands writes nothing (a failed stretch of a run already settled). listen-fire fails the run when a store module does not answer `parks.commitSegment`. A new read, `parks.owedRaces`, lists the races a run owes, which listen-fire reads as each stretch ends; `joins.deleteFrames` and `leases.dropRunState` drop them with their frame and their run. `waits.note` may name the `leaf` it was made under, which `parks.finishLeaf`, `parks.commit` and `parks.commitSegment` keep and `parks.claimLeaf` drops; `waits.note` may carry the run's lease (`fence`), and is refused (`run_lease_lost`) when it is lost (docs/contracts/store-slot.md).
  - A resumed `all` arm or fan-out iteration whose `match` finds nothing now settles null (the arm) or is skipped (the iteration), as it is on first reach. Before, it ended the whole movement.
  - `listen-fire run --dry-run` opens no wait, and its `await` binds an empty landing.
  - A run parked under 0.12 is refused on resume: `this run parked under listen-fire 0.12 (park state 2); a 0.13 engine resumes park state 3`. The park state contract moves to version 3: a record parks with its waits, and an await with the values its `WHERE` captured.
  - Embedders: the host families contract moves to version 2. A new optional family, `park.waits` (`mark`, `open`, `arrivals`, `note`), serves the waits; `park.sink.commitAwaitPark` and `park.wake` name the wait (`waitId`). A Rust embedding's `Store` gains the six wait methods, and `RunInput.trigger_mark`. See `docs/contracts/host-families.md` and `docs/embedding.md`.
  - The `wake` door refuses `{ keys }` (400, naming adapter protocol 2.5 and `arrivals`): a module reports what arrived instead. `resolveAwait` and `wakeKeys` are no longer called for a wait.
  - The acme example's CRM lists a company's comments oldest first, announces approvals on a company (`Approvals`, which only announces), and reports a deleted company's edges as gone.
  - Why: the module only reports what happened; `listen-fire` keeps what each run has waited for since its record entered, so an answer is never lost between a write and the wait that reads it.

- `@listen-fire/embed` (what `lf-platform` and SaaS embedders build on) fires a listen by the check's plan of it, as listen-fire does: an embedder hands its tenant's arrivals to `dispatch(tenant, { adapterType, connection?, arrivals })`, where it handed an event (`{ … event }`). Why: the listen is a traversal in 0.13, and the arrival that lands on its last edge is what fires it; both hosts now decide every arrival with the engine's one judge.
  - `SavedProgram.listens` holds the plan of each listen (`ListenPlan[]`), replacing `listeners`. A saved program the 0.12 way has none, and neither does one pinned to 0.12: it runs nothing, the host says so naming the program and the remedy (save it again), and the tenant's other programs still run.
  - Each arrival runs every saved listen on its module and last edge that hears its connection and whose judge says it fires. An arrival whose `notFor` is a listen's pipeline skips that listen. One the judge cannot decide runs nothing; the host says why, once per delivery, through the new `log` option.
  - `run(tenant, { program, text })` lands an Invocation on the manual unit's `Invocations` (`listen to manual-[:Invocations]-> fire f`), its `Text` the text given.
  - A save refuses, by name, a listen this host would not fire as written: one in the retired settings form (its 0.13 warning becomes the refusal); one whose earlier hop has a WHERE the module's arrivals do not carry the record for, which only listen-fire lists members to judge. Each would otherwise be saved and never fire, or fire on what it should not.
  - A listen that states the node its landing is (`listen to stripe-[:Requests]-><Payment> fire paid`) runs only on an arrival whose fields fit the node, as on listen-fire. One that fits no listen on its edge runs nothing, and the host says what does not fit, one line per listen, through `log`.
  - A delivery is one `dispatch` and one store write, as listen-fire keeps it: its arrivals logged, a work row for each run it starts, and a wait opened for each such run, on its trigger and on each record its trigger's arrival carries, from the mark before them, so a later item of the same delivery answers a run's `await new` and the trigger never answers its own; then the call starts each run from its row, and the runs its arrivals woke step on. `arrive` is gone: hand each delivery to `dispatch` alone. Why: two calls diverged from listen-fire in either order, and a forgotten `arrive` left awaiting runs asleep.
  - A run the call does not start (a store write failed, or the process died) is not lost: its row stays, and `tick` starts it once a run lease has passed. `dispatch` then throws, naming each run; a delivery with an `id` has the id forgotten, so the provider's retry is kept again, and still runs each arrival once. Why: the runs started after the write, and a failure there lost them, a retry under the same id being refused as kept before.
  - A listen runs an arrival once: its receipt (`arrivalReceiptKey`, listen-fire's `arrival_receipt_key`) is taken in the write that starts its run, so a redelivered arrival runs nothing. A delivery's `id` (the provider's) keeps a second delivery under it out whole.
  - The store's `runHost` serves `keepDelivery`, `completeKey` and `forgetDeliveryId` (`DeliveryRowStore`, which gains `forgetDeliveryId`) and `startArrivalRun` (the new `ArrivalRunStore`, taking the run row's fields and its team), as `memoryRunHostStore` does; a store of your own adds them. Over the store slot, the team is `events.startRun`'s new `teamId`.
  - A listen the save would refuse runs nothing when a store holds it all the same (an authoring tool's save), said on each delivery from its module; a listen whose stated landing cannot be read runs nothing alone.
  - Each saved program is read once by its content (its parse, its listens' pipelines, the node each states its landing is), not per delivery or arrival.
  - What the embedded host still does not do: there is no loop breaker (a listen whose run writes what it listens to fires on its own write), and a listen whose earlier hop only listen-fire lists members for is refused, not re-resolved.
  - `@listen-fire/authoring-mcp`: a save hands its host `listens` (the plans, against the tenant's catalog), replacing `listeners`; `runnable` is a listen on the manual unit; a save whose traversal listens do not all check warns how many will not fire.

#### Added

- A module's field may hold a record (`kind: "record"`, `record: { typeId }`): a value, not a reference, like a change's row before and after (`Current`, `Previous`). It reaches the catalog as the `record` field type with its position named (`{ "kind": "record", "position": { "kind": "position", "position": "Candidates" } }`: the checker's position reference, its instance the schema's own), and a field any record may lack says `mayBeAbsent` (`{ "kind": "maybeAbsent", "of": … }`). A dot read goes on through it as the record it is: `c.Current.Stage` is checked against that record's fields (`c.Current.Stge` is `MOV_UNKNOWN_PROPERTY`, naming them) and typed as its field, maybe absent where the record may be. It reads the same in a listen's `WHERE`, judged on both hosts from what the arrival carries, and in a body. `MOV_READ_THROUGH_FIELD` still refuses reading on past any other field, and an edge stays an edge: reading through it would hide a fetch. What such a field holds has its own type, TypeScript's plain object type: its fields, typed, and nothing else. It reads the same bound to a name (`r = c.Current`, then `r.Stage`), and where it may be absent the name may be too (`r.Score + 1` asks for a guard). It has no edges and no identity, so it is never walked off (`c.Current-[:X]->`, `r-[:X]->` and a block headed `r-[:X]->` are `MOV_WALK_OFF_HELD_RECORD`, pointing at the live record: `c-[:Record]->-[:X]->`), never written (`write r { … }` is `MOV_WRITE_POSITION_NOT_RECORD`), and never passed where a record is asked for (`g(c.Current)` into `<at-[:Candidates]->>` is `MOV_CALL_ARG_TYPE`); an edge's name read off it (`c.Current.Role`) points at the live record too. Its live record is an edge the module declares. Why: a change carries its row as it was and as it is, and a listen compares them (`c.Current.Stage == "Interview" AND c.Previous.Stage != "Interview"`) without a fetch, which a listen's `WHERE` may not make. Describe refuses a `record` field naming no type, in the same words in `listen-fire` and an embedder's describe. For `lf-platform`: a schema's field type may now be a `record` naming its position without its instance (`SchemaFieldType` gains `{ kind: 'record'; position }`); the platform's checker must type a schema `record` field through the instance whose schema declares it (its own `PositionTypeRef` carries the instance; the schema's does not), and as that position's fields held as a value, never as its record (no walk, write or record parameter takes it), as `listen-fire`'s checker does. `listen-arrivals.json` gains the cases.
- A narrowed record is accepted where the type it narrows is asked for. Assignability follows the narrowing walk that made the record, not its fields one by one, so it is not TypeScript's structural assignability: a function typed by every table's changes (`<hiring-[:Change]->>`) takes what a listen narrowed to one table fires (`Candidates Change`), and a table a WHERE selected passes where a `Table` is asked for. The narrowing is the record's derivation, followed hop by hop: an edge off a narrowed record lands on what narrows the same edge's landing off the type it narrows (the changes of one table narrow every table's changes; the live row of one of them narrows any row). Never the other way: a change of any table is still refused where one table's is asked for (`MOV_LISTEN_PARAM_MISMATCH`, `MOV_CALL_ARG_TYPE`). A record typed by its narrowed name alone (`<hiring-[:`Candidates Change`]->>`) carries no derivation, so it passes only where that name is asked for. Why: the per-table name is the precise spelling, and a generic function over every table's changes should not have to be written once per table.
- `listenSettingsBecome` maps a settings key by `contains`: a member of a list field, several values an OR of them (`labels: ["INBOX", "SPAM"]` becomes `m.Labels CONTAINS "INBOX" OR m.Labels CONTAINS "SPAM"`).
- A listen whose hops walk the edge its arrivals carry a record for more than once (`-[:Folders]->-[:Folders]->-[c:Notes]->`, `Notes` carrying `Folders`) is told so where it is written, when the program awaits an edge off that record (`MOV_CARRIED_WAIT_FROM_WALK`, a warning): an arrival carries one record per edge name, so those waits count from where the function walks to the record, not from the arrival.
- `listenSettingsBecome` maps a settings key by `neq` (`field != value`). A mapping may say `fieldChange`: two settings keys that compare the row a hop's records hold before and after the change (`{ hop, field, becomes, current, previous }`). Airtable's `field: "Stage"` alone becomes `c.Current.Stage != c.Previous.Stage`; with `becomes: "Interview"` it becomes `c.Current.Stage == "Interview" AND c.Previous.Stage != "Interview"`; `becomes` alone narrows nothing, as in 0.12. The field is checked against the row the rewritten path lands on: where the host narrowed its hops by their WHEREs, the narrowed row, and the fired parameter is retyped to the narrowed landing (``<hiring-[:`Candidates Change`]->>``); where it did not, every table's row (`Row`). A field the row lacks has no rewrite, and the listen is told the fields there are, so `upgrade` never writes a listen that does not check. A field a listen compares by identity rather than by value (a file, json, a structure, or a list of any of them) is rewritten without `safe`, and the listen is told why: it may run on every update where 0.12 ran when the field changed. `listen-fire upgrade` narrows the catalog by the hops a rewrite walks and upgrades the file again against it, so the rewrite is checked as it will run. A rewrite whose field could not be checked because the catalog was not narrowed by its hops is withheld, and its diagnostic names the traversal it would walk (`walks`, a new optional member of a diagnostic): `upgrade` narrows by that too and checks again, and where the table cannot be narrowed the listen keeps its pin and is told why. For `lf-platform`: a diagnostic may carry `walks`; a host that narrows its catalog by a file's hops narrows by it too before upgrading again. Describe refuses a `fieldChange` past the path or on a key the mapping also maps, in the same words in `listen-fire` and an embedder's describe.
- `@lf/stripe` is listened to on the `Changes` of the object each event is about, pushed to the connection's door: `pay-[:Invoices]->-[c:Changes WHERE c.Kind == "payment_failed"]->`, and a subscription's, a customer's or a charge's `Changes` likewise. Each object's events are its own change type (`InvoiceChange`, `SubscriptionChange`, `CustomerChange`, `ChargeChange`), whose `Kind` is the event type without the object's prefix and only that object's: `listen-fire check` refuses a kind that never arrives on the edge. A run can wait on a record's next change (`await new inv-[:Changes]->`). Each arrival carries the object as the event had it, so a WHERE on the invoice's hop is judged on the arrival. A 0.12 `listen to pay { events: ["invoice.payment_failed"] }` becomes `pay-[:Invoices]->-[c:Changes WHERE c.Kind IN ["payment_failed"]]->`, its parameter `<pay-[:InvoiceChange]->>` (`listen-fire upgrade`). One naming events of two objects, or none (it heard every event), has no rewrite and is told to write one listen per edge. Stripe's re-send window, three days, is a default lf.yaml's `resendWindow` overrides.
- `@lf/stripe` states adapter protocol 2.6 (`protocolMinor: 6`), as every bundled module whose arrivals carry `parents`, `about` or `occurredAt` does, so a host that speaks less refuses it by name. `listen-fire modules show --json` says the minor a module needs (`protocolMinor`).
- `@lf/airtable` is listened to on a table's `Changes`, walked to by name: `listen to at-[b:Bases WHERE b.Name == "Finance"]->-[t:Tables WHERE t.Name == "Expenses"]->-[c:Changes WHERE c.Kind == "created"]-> fire review`, and from a connection positioned at its base `hiring-[t:Tables WHERE …]->-[c:Changes …]->`. A change is one per row an edit touched: `Kind` is `created`, `updated` or `deleted`; `Current` is the row as the edit left it and `Previous` as it was, each a `record` field read through with `.` and absent where there is no row (`Previous` on a created row; both on a deleted one, as Airtable sends no cells then). Narrowed to one table, its `Changes` land on that table's change type (`Candidates Change`), whose rows are typed by the table's fields: `c.Current.Stage == "Interview" AND c.Previous.Stage != "Interview"` is checked, and `c.Current.Stge` refused where it is written. Every table's changes are `Change`, whose rows are `Row` (`Id`); a function typed by them takes a narrowed listen's changes too. `c-[:Record]->` is the row as it is now, read from Airtable (none once deleted); a listen's WHERE cannot walk it. A table named as another's changes (`Candidates Change`) is refused where its base is described. listen-fire's narrowing walks on from what a narrowed table's edges land on, so the table's change type and its row type exist when the connection is not positioned at a base. listen-fire registers one data webhook per base a listen's tables are in, over every table of the base, whatever number of them the listen watches (`Changes` declares `scopedBy: "Bases"`: `ensureEventSubscription({ edge: "Changes", scope: <base id> })`; at a connection positioned at its base, `Changes` is delivered to the connection, one webhook for it), and keeps only the changes of the tables the listen watches; and one schema webhook (Airtable's `tableMetadata`) per base whose tables a listen narrows (`{ edge: "Tables", scope: <base id> }`). That is 2 webhooks per base, the most Airtable lets one OAuth integration make there ([create a webhook](https://airtable.com/developers/web/api/create-a-webhook)), so a listen over any number of tables of a base fits; a second connection, credential or position over the same base would need 2 more and is refused by Airtable. Folding the two into one webhook per base is a follow-up. A table renamed into a listen's WHERE in a base already watched needs no new webhook, only the listen listed again. `Tables` declares `parentChanges: pushed`, so a table renamed into a listen's WHERE is watched from the moment Airtable reports the rename, and its changes from before are never replayed. `Bases` is listed again every hour (`relistEverySeconds: 3600`; lf.yaml's `resolveEvery` overrides it). A change is named by the base's transaction and the row, so a payload pulled again runs nothing; arrivals say `about` the row and `occurredAt`. A run can wait on a table's next change (`awaitKeys` keys it by the table's id). It states adapter protocol 2.6. The root's `Base` collection is now `Bases`, and a base has `Tables`. Why: a listen that names its table by name follows a rename, which an id in the settings form could not. The `Record Change` type, `listenConfig`, `subscribableEvents`, `subscriptionScopeKeys` and `listEventTypes` are gone. `listen-fire upgrade` rewrites `listen to hiring { base, table, events, field, becomes }` onto the table's `Changes` (`base` and `table` by `Id`, `events` as `Kind IN`, `field` as `c.Current.Stage != c.Previous.Stage`, and with `becomes` as `c.Current.Stage == "Interview" AND c.Previous.Stage != "Interview"`; a connection positioned at the base drops the `Bases` hop) and retypes a parameter typed ``<hiring-[:`Record Change` WHERE `table` == "…"]->>`` as the table's change type (``<hiring-[:`Candidates Change`]->>``). Each rewrite keeps 0.12's meaning, so each is applied without `--all`: one change per row an edit touched runs a listen once per update, as 0.12 did, and a row created holding the value came to hold it, as 0.12 counted. A cell an update empties is absent from `Current`, whether Airtable leaves it out of the payload's current cells or holds it null (then it reads null). Every cell of `Current` and `Previous` is the value its field declares, never the object Airtable sends, so a listen compares them by value: a select by its choice's name, a collaborator (and `createdBy`, `lastModifiedBy`) by its email, a barcode by its text, an AI text by its value, a button by its label, a linked record by its id, a lookup as its values in link order, and an object a formula or rollup computes as its JSON. Attachments stay as Airtable sends them: a `field` naming one is rewritten, but not safely, since a listen compares files by identity. A lookup is declared a list of text, as Airtable holds it. On registering with no webhook held, the module first deletes any webhook at the same door: Airtable keeps a lapsed webhook, disabled, for 7 days, and it may count against the 2 per base. For `lf-platform`: keep each tenant connection's webhook door URL its own, as listen-fire's door is (its public base with the adapter, credential and scope); one tenant's registration otherwise deletes another's webhooks at a shared door. A base's `Tables` and the root's `Bases` are read from Airtable each time they are listed, never from the module's cache, so a listen listed again sees a rename at once, in whichever process lists it. A base holding a table named `Base`, `Table`, `Change`, `Row` or `Tables`, or one named as another table's changes, or a table with a link field named `Changes`, is refused where it is described, naming the table or field to rename in Airtable: those are the names the module gives its own types and edges, and one would shadow the other. The fake Airtable refuses a third live webhook on one base (an OAuth integration's cap of 2), models schema webhooks (`dataTypes: ["tableMetadata"]`), renames a table (`/airtable/control/rename-table`) or a base (`/airtable/control/rename-base`), and makes a table (`/airtable/control/create-table`).
- `@lf/attio` is listened to on a record's `Changes`, pushed through one webhook per connection: `crm-[:Deals]->-[c:Changes WHERE c.Field == "Stage"]->`, and every object's records likewise. Each object's changes are their own record type (`DealChange`, `CompanyChange`, `PersonChange`): `Kind` is `created`, `updated` or `deleted`, and on an update `Field` is the title of the attribute that changed, an enum of the object's attributes, so `listen-fire check` refuses one the object lacks. Each arrival carries the record as Attio holds it after the change, so a WHERE on the record's hop is judged with no read; walk the change's `Deal` (its object's singular) for the record. A change is named by the record and, on an update, the attribute and its value now, so a redelivery runs nothing and the attribute's next change runs again; `occurredAt` is when Attio says the value took effect (a creation: the record's `created_at`). A run can wait on a record's next change (`await new d-[:Changes]->`). It states adapter protocol 2.6. `listen-fire serve` registers the webhook for the edge (`ensureEventSubscription({ edge: "Changes" })`), taking `record.created`, `record.updated` and `record.deleted`. The `Webhook Event` type, `listEventTypes`, `subscribableEvents` and the snapshot trigger are gone. A 0.12 `listen to crm { events: [...] }` heard every object's records, and Attio's objects are each workspace's own, so there is no rewrite: `listen-fire upgrade` holds the pin until it is rewritten by hand, one listen per object.
- `@lf/affinity` is listened to on a record's `Changes`, pushed through one webhook per connection: ``crm-[:`List Entry — Master Deals List`]->-[c:Changes WHERE c.Field == "Status"]->``, and an organization's, a person's or an opportunity's likewise. Each record type's changes are their own record type (`OrganizationChange`, `PersonChange`, `OpportunityChange`, `List Entry Change — <list>`): `Kind` is `created`, `updated` or `deleted`, and when a field value was set or cleared (`updated`) `Field` is the field's name as the record shows it, an enum of the record's own fields, so `listen-fire check` refuses one the record lacks. A deal's stage is a field of its list entry. Each arrival carries the record as Affinity holds it after the change, so a WHERE on the record's hop is judged with no read; walk the change's `List Entry` (`Organization`, `Person`, `Opportunity`) for the record. Affinity names no change, so a change is named by its event and a digest of what it said: a redelivery runs nothing. A run can wait on a record's next change. It states adapter protocol 2.6, and `listen-fire serve` registers the webhook for the edge. `subscribableEvents` is gone; notes and reminders run nothing. A 0.12 `listen to crm { events: [...] }` naming an organization's, a person's or an opportunity's events is rewritten onto its `Changes`, `Kind` compared with the events' kinds; one naming a list entry's or a field value's event (its list is the workspace's own), a note's or a reminder's, events of two record types, or none, has no rewrite, and `listen-fire upgrade` holds the pin.
- `@lf/telegram` is listened to on `Messages`, a root edge pushed to the bot's webhook: ``listen to tg-[m:Messages WHERE m.`Chat Id` == "42"]-> fire f``. Each message the bot receives is one arrival landing on the `Message` itself, with `Id` (the chat and the message id: Telegram numbers a message within its chat, so a redelivery is the same arrival and another chat's message with the same id is not) and `occurredAt` from its `date`. Telegram cannot list chats, so a listen narrows to one by the message's own `Chat Id`, not by a hop through a `Chats` edge; the host judges that comparison. It states adapter protocol 2.6. `listEventTypes`, the `fires` edge `Message` and the event parse are gone: only plain messages arrive (an edited message, a channel post and a button tap run nothing, as before). A 0.12 `listen to tg {} fire f` is rewritten to `listen to tg-[:Messages]-> fire f`, its parameter `<tg-[:Messages]->>` (`listen-fire upgrade`). A host that took Telegram's events through `preprocessInbound` or `listEventTypes` (lf-platform) reads `arrivals` instead.
- `@lf/whatsapp` is listened to on three root edges, one per kind of record that arrives, each its own record type and pushed to the connection's door: `wa-[m:Messages WHERE m.From == "447700900001"]->` (`Message`), `wa-[r:Reactions WHERE r.Emoji == "👍"]->` (`Reaction`, `about` the message it is on) and `wa-[l:Locations]->` (`Location`). A reaction runs only a listen on `Reactions`, never one on `Messages`. Each is named by its WhatsApp id, so Meta's resend of a delivery is the same arrival, at the time Meta stamped it. WhatsApp cannot list conversations, so a listen narrows to one by the sender's number, `From`, on the record itself; the host judges that comparison. It states adapter protocol 2.6. `listEventTypes`, the three `fires` edges, `subscribableEvents`, `defaultSubscribedEvents` and `triggerAcceptsWhatsappKind` are gone: `checkInbound` and `preprocessInbound` answer `arrivals`, no events. A 0.12 `listen to wa { events: ["reaction"] }` is rewritten to `listen to wa-[:Reactions]-> fire f` (`location`: `Locations`; `message`, or no events, which heard messages only: `Messages`), its parameter `<wa-[:Reactions]->>`; one naming events of two kinds has no rewrite and is told to write one listen for each (`listen-fire upgrade`). A host that took WhatsApp's events from the module (lf-platform's Meta door) reads `arrivals` instead.
- `@lf/gmail` listens on `Messages` (each message added to the mailbox, narrowed by `m.Labels CONTAINS "INBOX"` and `m.Query == "…"`, Gmail's own search) and `Labelings` (each label added to a message already there: `l.Label == "Deals"`, or `` l.`Label Type` == "user" `` for the mailbox's own), each polled every minute and shared by the listens with one WHERE. Why: a listen is a traversal, and a label added is its own arrival, not a second delivery of the message. A 0.12 `listen to mail { query, labels }` is rewritten to `Messages`, the inbox when it named no labels; `{ events: ["label_added"] }` to `Labelings`, the mailbox's own labels when it named none. A label removed and added again now fires again (0.12 fired once per message and label).
- `@lf/gmail` `Labels` carries label names, not ids, on every path: a user label as the mailbox calls it (`Deals`, where a message carried the id `Label_12`), Gmail's own as before (`INBOX`, `SENT`). A walk's `m.Labels CONTAINS "Deals"` is now judged by the name it pushes to Gmail's search, and a listen's arrivals carry the same names it compares. A program that compared `Labels` with a user label's id must compare its name. A labeling's `Label` is the name too (`Deals`, where 0.12's `Added Label` was the id `Label_12`), so `l.Label == "Deals"` compares what the arrival carries.
- `@lf/granola` listens on `Meetings`, the edge past notes are read along: `listen to granola-[n:Meetings WHERE n.Folders CONTAINS "deals"]->`, polled every five minutes and shared by the listens with one WHERE. `Folders` is new: the folder names, lowercased, as 0.12's `folder` compared them. A 0.12 `listen to granola { folder }` is rewritten to it.
- `@lf/dealroom` listens on `Funding Rounds`, the edge past rounds are read along: ``listen to dealroom-[r:`Funding Rounds` WHERE r.Round IN ["SERIES A"]]->``, polled every ten minutes and shared by the listens with one WHERE. `Company Industries` and `Company Locations` are new: the industries, and the cities and countries, of the company that raised. Dealroom judges them (its vocabulary has regions, such as `"Europe"`, that a round never lists), so they are compared with `CONTAINS` (or an OR of them, any of several) only where Dealroom's search can take it: a walk of a company's own rounds, or a listen comparing them inside an OR with another field, is refused where it is written (`MOV_FILTER_NOT_TAKEN`). A 0.12 `listen to dealroom { rounds, industries, hq_locations }`, with `events: ["funding_round"]` or without, is rewritten to it.
- `@lf/evertrace` listens on `Signals` (new signals, narrowed by ``s.`Saved Search` == "…"``, a saved search by title or id) and `List Entries` (a signal added to a list, narrowed by ``e.`List Name` == "…"``), each polled every five minutes with its own cursor. `Saved Search`, `List Name` and `List Id` are new. Only Evertrace can say what a saved search matches or which list an entry arrived on, so a comparison on either that Evertrace cannot take is refused where it is written (`MOV_FILTER_NOT_TAKEN`); a walk of `Signals` by ``s.`Saved Search` == "…"`` reads through the search. A 0.12 `listen to evertrace { search }` is rewritten to `Signals` and `{ events: ["list_entry"], list }` to `List Entries`; one naming both events has no rewrite, so write one listen for each.
- `listenSettingsBecome` chooses a mapping by the event a listen names (`byEvent`), for a module whose events arrive on more than one edge: gmail's `{ events: ["label_added"] }` becomes a listen on `Labelings`, not `Messages`. A 0.12 listen naming events that arrive on two edges has no rewrite; its message says to write one listen per edge. One naming an event the mapping does not, beside one it does, has no rewrite either, and is told the module's events.
- An event that chooses its mapping (`byEvent`) is still compared when that mapping maps `events` itself: Stripe's `invoice.paid` chooses an invoice's `Changes` and becomes `c.Kind IN ["paid"]`. A listen that names no events chooses by what the module's own `events` key says leaving them out heard (`absent`), where the module declares no default events: a Stripe listen naming none heard every object's events, so it has no rewrite and is told to write one listen per edge. A message naming the edges of two mappings names each by its whole path when two end on edges of one name (`-[:Invoices]->-[:Changes]->` and `-[:Charges]->-[:Changes]->`).
- A field takes an OR of `CONTAINS` on it when it declares `containsAny` (adapter protocol 2.6): the module matches any of the values. The rewrite of a 0.12 key with several values (gmail's `labels: ["Deals", "Hiring"]`, by name) is offered as safe only where the field declares it; elsewhere the host compares each value exactly, and the fix is offered unsafe, saying so. A key's `absentField` names the field what leaving the key out meant is compared on, when that is not the key's own (gmail's `labels` left out of a label listen meant the mailbox's own labels: `` l.`Label Type` == "user" ``).
- `@listen-fire/engine/public/inbound`: `listenFires(listen, arrival, { adapterType, credentialName? }, nowMs)` (the verdict, or null for an arrival that is not the listen's to judge), `plannedListensOf`, `listenPipeline`, `listenIdentity` and `arrivalTriggerOf`. The pipeline is `listen:<file>:<movement>:<digest>` on both hosts, held to one table of cases (`engine-contracts/conformance/listen-pipelines.json`) that listen-fire's routing and the engine's TypeScript both read; the wasm exports `listen_identity` for it. `landingMisfits({ source, node, landing })`: what of an arrival's landing does not fit the node a listen states it is, the engine's one check (`movement_engine::listen_landing`, which listen-fire calls natively and the wasm exports as `landing_misfits`), held to `engine-contracts/conformance/listen-landings.json`. `landingNode({ source, node })` reads the node once (the wasm's `landing_node`), and `landingMisfits` takes it in place of the source. `arrivalReceiptKey` and `triggerAwaitsOf` (the edges a fired function awaits off its parameter, from the check's stamps). The store's `ArrivalRunStore.startArrivalRun` (the store slot's `events.startRun`, by team).
- `@lf/system`, bundled: the host itself as an ordinary module, with no engine or language support. A program listens to `sys-[e:Events WHERE e.Kind == "Run Failed"]->` (or `e.Kind IN [...]`), and hears a run of another program failing (never a rehearsal), a wait whose record was deleted (`Wait Lost Its Record`, with its `Adapter`, `Edge` and `Record Id`) and a release first run (`Release Applied`) (docs/contracts/system-events.md). Why: a failure, or a wait that will never end, is something a program can act on, and a stranded wait was only visible in `listen-fire runs`.
  - It polls listen-fire's new records door (`/api/public/adapter/<module>/records`, beside the models, OCR and limits doors, under the host token; module-kit's `ctx.records`), every minute by default (`pollEvery` in lf.yaml; the settle lag and page size in the install's env). The first poll only arms.
  - A program is never told of its own listen's failures or waits: each event is `notFor` that run's listen. A failure handler failing on another's failures is a chain the loop breaker pauses at `loopDepth`: the door keeps each fact about a run in the write ledger as that run's own write, and each event is `about` its run.
  - listen-fire never reports `Run Paused` (it fails a run at its cost cap), `Validation Issue` or `Deprecated Version` (it refuses to serve a project that does not check).
  - A 0.12 `listen to sys {}` upgrades to `e.Kind == "Run Failed"`, and `listen to sys { events: [...] }` to `e.Kind IN [...]`.
  - The store slot gains `runs.failed`, `releases.note` and `releases.list`; `waits.open` takes the record's `recordId` and `waits.stranded` answers it (`@lf/postgres-store` migration 15). The engine names the record it opens a wait on (`park.waits.open`'s `recordId`), and `waits.open` fills in the id of a wait a delivery opened without one (a wait that has an id keeps it). `writes.record` replaces the run's earlier write of the same record.

- A listen states the type of an untyped landing after its traversal: `listen to hooks-[:Requests]-><Payment> fire paid`. The node must be one the program declares, the fired function's parameter must be assignable to it, and the plan carries it (`ListenPlan.landing`).
- A module may declare `listenSettingsBecome` in its manifest: how its 0.12 settings listens become traversals (the edges from the connection to the listened edge, an alias per hop, the record type a fired parameter was typed as, and the hop, field and comparison of each settings key, what leaving a key out meant, and whether its values were compared lowercased). `listen-fire` carries it into the catalog and refuses, when the module is described, a path naming an edge the module does not describe, a key mapped past the path, a comparison naming no field, or an `absent` its key cannot compare; an embedder's describe refuses the same in the same words (docs/contracts/adapter-protocol.md).
- A module declares how each listenable edge is listened to, and `listen-fire` carries it into the catalog (docs/contracts/adapter-protocol.md, "Declaring a listenable edge").
  - `delivery`: pushed to the connection, pushed per scope (a table), or `polled` every `pollEverySeconds`.
  - `bounded: false` with `boundedBy`: an edge that spans more than a listen should range over (every cron schedule, every team's mail), and the fields whose `==` or `IN [ … ]` narrow it.
  - `carries`: the earlier hops whose records an arrival carries, outermost first. `attributes`: an arrival names the record it is about.
  - `cheapToList`: a hop cheap enough to re-list, with either `parentChanges: "pushed"` (the module reports its members' changes, as arrivals on the hop's own edge, so nothing re-lists on a clock; such a hop must be `listenable`, or describe refuses it) or `relistEverySeconds`, in seconds.
  - An entry point may declare `listenable` (with `identity`, `version`, `cursor` and the keys above): a listen can then start at the instance, as `cron-[t:Ticks WHERE …]->` will.
  - A field may be of kind `owned`: a named scalar its module parses, such as a cron schedule. One that names no scalar is refused, naming the field. A manifest may declare `resendWindowSeconds`, how long its provider may re-send an arrival.
  - Every number a module declares is a default the operator's `lf.yaml` overrides; the host has none of its own, so the module states each one.
  - A declaration that cannot mean what it says is refused, by name, when `listen-fire` or `introspectAdapter` describes the module: a polled edge without `pollEverySeconds`, `bounded: false` without `boundedBy`, a `boundedBy` field or a `carries` hop that is not there, a hop cheap to list that says nothing of how its members change.
  - The catalog snapshot carries them as optional members, so its version stays 2. A root collection that cannot be listed now says `readable: false`. The checker reads `bounded`, `boundedBy`, owned fields and `readable` (under Checks, below); the rest are read by the listens to come.
  - Why: a standing listen becomes a traversal over the edges a module declares listenable, and only the module knows how its arrivals arrive, what bounds an edge, and how often to poll or re-list.
- A run parked on a record that was deleted says so. The store marks such a wait stranded and keeps it parked, until the record reports again (docs/contracts/stranded-waits.md).
  - `listen-fire runs` lists the run `parked (stranded)`; `--json` gives each run `stranded`.
  - `listen-fire runs show` lists each stranded wait under `stranded`, saying what it waits on: `waiting on Interactions of slack C1:… — its record was deleted, so nothing will arrive; a race with a sleep is the way out`.
  - Why: from 0.13 such a wait never resolves, so a run stuck on one would otherwise look like any parked run.
  - Store modules: `waits.log` answers `{ wakes, stranded }`, and `waits.stranded` reads one run's stranded waits or every run's a page at a time (the feed `@lf/system` will read). `waits.open` takes a `null` key for a record already gone; `waits.arrivals` answers no `gone`. `@lf/postgres-store` gains migration 11; the SQLite state file rebuilds its wait rows once. The engine's `park.waits.open` takes `gone: true` in place of a key, and park state 3 holds a wait id for every edge (docs/contracts/store-slot.md, host-families.md).
- A listen can be written as a traversal: `listen to chat-[:Channels]->-[m:Messages WHERE m.Topic == "lunch-poll"]->-[:Interactions]-> fire count_vote`. It ends on an edge its module announces arrivals on, and the function it fires is called with what lands there.
  - The check answers a plan for each such listen (`listens` on the engine's `check.program` answer; `ListenPlan` in `crates/movement-parser`, `listenPlanSchema` in `@listen-fire/engine-contracts`). Per hop it says which part of the `WHERE` the module takes, which part the host checks, and how the host honours a filter on a hop before the last: judged on each arrival, when the arrival carries that hop's record (`carries`), or by listing the hop's members, when every hop down to it is cheap to list (`cheapToList`). When the last edge is pushed per scope (`delivery: scope`), every hop before it is listed, filtered or not: the host lists the heads to subscribe to each.
  - Two listens with the same plan are one listen too many (`MOV_LISTEN_DUPLICATE`), however their hops' aliases are spelled. As for the settings form, a lane's name (`listen as "…"`) does not make another listen.
  - The settings form, `listen to x { … } fire f`, checks and runs as before. `listen-fire` runs a traversal listen (below); the embed host reads the plans in a later change.
  - Editors: after `listen to x-[`, completion offers the edges a listen can take, those it can end on first.
  - Why: a standing listen is a traversal over the edges a module declares listenable, checked as a wait is, so the host can push filters to the module and never range over what it cannot watch.
- One judge decides whether an arrival fires a traversal listen, the same on both hosts: `judge_arrival` in the engine (`crates/movement-engine/src/listen_judge.rs`), reached from TypeScript through the wasm as `judgeArrival` (`@listen-fire/engine/public/inbound`, beside `listenPlansOf`, which reads the plans off a check answer).
  - It judges only the hops the plan judges on arrival, each against the record the arrival carries for it. A hop's checked part is always evaluated; its taken part too, unless the arrival says its module applied it (`takenApplied`).
  - Its verdict is `{fires: true}`, `{skips: n}` (the hop whose filter fails), or `{undecided: reason}`. An arrival is undecided when it lacks a record a filter reads, or when its module did not apply a filter on a field only the module can evaluate. A hop that fails decides over one that is undecided.
  - A plan's hop names those fields (`owned`). The engine contracts' expression schema now keeps a hop's alias read (`fieldOnly`) and takes `within`, `negate`, an object literal's spreads, `llm`'s `tier`, `only` and `sort`, and an expression as an aggregate's `orderBy` (every shape the Rust lowering writes is held to `conformance/expression-samples.json`); the TypeScript check answer carries `listens`.
  - Both hosts are held to the cases in `packages/engine-contracts/conformance/listen-arrivals.json` (`listenArrivalCasesSchema`). No host calls the judge yet.
  - Why: an arrival must fire the same listens whichever host receives it, and a filter the host cannot judge must be said, never guessed.
- `listen-fire` runs a traversal listen on what a module reports landed on its last edge (adapter protocol 2.6). `listen to crm-[c:Company WHERE c.Name != "Ignored"]-> fire welcome` runs `welcome` for each company the CRM reports, its parameter bound to the company that landed, as a wait binds what lands on its edge.
  - Arrivals reach it from a delivery (`preprocessInbound`, `checkInbound`'s `accepted`) or a push to the `wake` door. Each is judged against every traversal listen on its edge that hears the connection it came for (the judge above). A delivery's events still go to the listens in the settings form only, and its arrivals to traversal listens only.
  - The same arrival (its edge, key, identity and version) delivered again runs a listen once, saying `has run the arrival … before`. One the listen's `WHERE` refuses runs nothing, and says so only under `LF_LOG=debug` (a new variable: `debug` adds the lines that explain why something ran nothing when nothing went wrong). One the judge cannot decide runs nothing either, and its reason is said once per delivery.
  - A traversal listen's pipeline is `listen:<file>:<movement>:<digest>`, the digest being the first 8 hex digits of the sha256 of the listen's identity. So two listens in one file that fire one function each run once for an arrival both take, and `notFor` names one of them. A listen in the settings form keeps `listen:<file>:<movement>`.
  - A traversal listen's pipeline changes when its plan changes (an edited `WHERE`, or a module schema change that alters the plan), and its receipts and the `notFor` that names it change with it: an arrival delivered again across such a change runs the listen again.
  - A listen that would never fire is named where it is written when a project is served: a traversal listen the check refuses, one that cannot be planned because the catalog does not load, or a listen on a connection the file does not make (a file cannot export a connection, so one imported from another file is refused by name). Before, a listen of the settings form on such a connection was dropped without a word.
  - A run it starts is handed the arrival as its event (`triggerType: "arrival"`, with `arrival: { adapterType, edge, landing, parents? }`), shown by `listen-fire runs show`.
  - Adapter protocol 2.6: an arrival on a root edge (an entry point declaring `listenable`) names no `key`, and is not logged for waits. An arrival may carry `parents` (the records of the earlier hops its edge `carries`), `about`, `notFor` (the listen it must not run, by its pipeline) and `takenApplied`. `listen-fire` and the engine speak 2.0 to 2.6; a module reporting a root arrival states `protocolMinor: 6`. The example CRM's companies are a listenable root, each reported as an arrival beside its `company.created` event.
  - A traversal listen's hops are walked when `listen-fire` narrows a connection's schema by a `WHERE`, as an `await`'s are.
  - Why: the plans the check writes are what a host watches, so a listen fires on what lands on its last edge and its filters are judged one way, never on a module's settings.
- `listen-fire` polls a polled listenable edge once per connection, edge, filter the module takes and scope, shared by every traversal listen on it (adapter protocol 2.6). Before, a polled source was polled once per listen.
  - The call is `poll({ edge, filter?, scope?, cursor? }) → { arrivals, cursor? }`: `filter` is the part of the listens' `WHERE` on the edge the module takes, and an arrival says `takenApplied: true` only when the module applied it, so the host checks the whole filter on any other. Two listens with different taken filters are two polls; two that differ only in what the host checks share one.
  - Each poll is a `poll_edge` work row (a new kind for `listen-fire drain --kinds`), so two workers never poll one edge at once. Its first poll only sets the cursor: what was there before fires nothing. After that, each arrival is logged for the waits and judged against each listen sharing the poll, each running once per identity and version: a record edited so that it newly matches a filter is a new version, so it fires.
  - The interval is the operator's `pollEvery: { <credential>: <duration> }` in `lf.yaml` for the connection (a connection that uses no credential is named by its module), else the edge's `pollEverySeconds`. listen-fire has no interval of its own.
  - An entry point may declare its root collection's `capability` (`{ filter: "native", supportsLimit: false }`), as a reference does its edge's: a host that asks for no root descriptor, as listen-fire does not, reads what a root edge takes there.
  - Two connections of one module and credential that differ only in their position (`connect airtable { base: "CRM" }` and `{ base: "Hiring" }`) are polled apart, each in its own position.
  - `listen-fire run --poll <movement>` polls at once each edge a traversal listen firing it is on, once for every listen sharing the poll, as it polls the settings form's sources.
  - The settings form's polls (`poll({ config, checkpoint?, movementId? })`, a `poll_listen` row per listen) are unchanged.
  - Why: a poll costs the outside system, so the listens on one edge share it, and the operator sets how often it is paid for.
- `listen-fire` watches a traversal listen whose earlier hop it resolves (`listen to f-[b:Boards WHERE b.Name == "Ops"]->-[n:Notes]-> fire a`) on the records those hops land on, its heads: the last edge is polled or subscribed to once per head.
  - The heads are read through the engine, as a run's walk reads them (each hop's `WHERE`, the part the module takes and the part the host checks), with no run row. They are read when a session that routes listens first opens on the listen (an edited listen is a new one, read afresh, and so is one whose connection is constructed with another credential or other arguments: its receipts are its own too), and kept in the store (`listens.states`, `listens.claimResolve`, `listens.saveResolution`, `listens.setPaused`; `@lf/postgres-store` migration 12). One process reads a listen at a time, under a hold the store keeps; two opening at once read it once. A read that meets another process's hold is made again once that hold is let go or lapses (the listen's `resolve_listen` row, tried again while the hold stands), so neither a report of a parent's change nor a process that died while reading leaves the listen unread.
  - The store's heads are the ones watched: every process routing the listen watches what the store keeps, whichever process read them. A drain reads them at each pass, and `listen-fire serve` moves its webhooks with them, so a `resolve_listen` pool beside the polling workers moves what they poll.
  - They are read again as the hop's module declares: every `relistEverySeconds` (a `resolve_listen` work row, a new kind for `listen-fire drain --kinds`; `lf.yaml`'s `resolveEvery: { <credential>: <duration> }` overrides it), or, for a hop declaring `parentChanges: pushed`, on each arrival on that hop's own edge, with no row: `listen-fire` polls or subscribes to that edge for the listen itself, sharing the poll or subscription of any listen on it, and those arrivals fire nothing of their own. A listen with neither, and no `resolveEvery`, is read only as a routing session opens: said once as it opens, and `listen-fire listens` shows it `resolved at open only`. Between two reads a record renamed out of the filter keeps firing, and one renamed in does not. A head that drops out loses its cursor: if it comes back, it is watched from then, and what changed while it was out never fires.
  - An arrival under a record the listen does not watch runs nothing. An arrival that names no record it is under, from a poll or a subscription made for one head, is under that head, for the waits that log it as for the listens. An edge pushed to the connection (`delivery: connection`) is one subscription for all a listen's heads, its arrivals naming the head each is under; an edge polled or pushed per scope is one per head.
  - A listen whose hops match more records than `lf.yaml`'s `listenScopeLimit` (default 500) is suspended, watched nowhere, until they match fewer: `LISTEN_SCOPE_LIMIT: <file>:<movement> matched more <position>s than its limit of <limit>; …`. The read stops one record past the limit, so such a listen is never read whole. One whose read fails keeps watching what it watched, and `listen-fire listens` dates it by the read it kept: `LISTEN_RESOLVE_FAILED: …`. Each is printed when a routing session opens and whenever it changes (a cleared one says the listen watches again), and is read again at the next open.
  - `listen-fire listens` prints one line per traversal listen: its traversal, how each hop's filter is honoured (`arrival`, `resolved`, `unfiltered`), what it watches and when it last resolved, and whether it is ok, failing or paused, noting a listen whose arrivals the loop breaker cannot match to a write (they name no record they are about, and land on records no write to their module makes), and one on a module that does not read a record back (a write that changes nothing is still sent). `listen-fire listens resume <file>:<movement>` lets a paused listen fire again; a read of the listen never undoes a pause or a resume made meanwhile.
  - The engine takes a `walk` entry beside `segment`: a segment's input plus `connection`, `hops` (a listen plan's hops) and an optional `limit`, walked through the program's own connections, answering the records they land on as positions; with `limit`, it stops once its last hop lands on more than `limit` distinct records, a record two paths land on counted once, paging no further. listen-fire reads the heads through it, from the plan, never from the listen's text, so it reserves no name in the program. No language behaviour changes.
  - A hop listen-fire reads that hangs off a record, whose module reports its changes per that record (`parentChanges: pushed` with `delivery: scope`: Airtable's `Tables`, one schema webhook per base), is watched once per record it hangs off: listen-fire lists those records in the same walk as the heads, keeps them beside them (`listens.states`' `parents`), and subscribes to the hop's edge under each, so a change reported for any of them lists the listen again. Those records move the webhooks when they change, even when the heads do not: a base renamed into a listen's WHERE that holds no matching table yet is watched for one. They count against `listenScopeLimit` too, and an overflow names their type (`matched more Bases than its limit`).
  - An edge pushed per scope may name an earlier hop it is subscribed per (`scopedBy`, a module's declaration: Airtable's `Changes` by `Bases`): listen-fire then subscribes once per record that hop landed on for the listen, listed in the same walk as the heads and kept beside them, not once per head, and keeps only the arrivals under the listen's own heads (each still names the head it is under). Why: Airtable allows an OAuth integration 2 webhooks per base, so a webhook per table watched could not watch a second table of a base. Describe refuses a `scopedBy` on an edge not delivered per scope or on a root collection, or naming a hop that some path to the edge does not come through, in the same words in `listen-fire` and an embedder's describe. A listen's declarations are read from the schema of its connection's own position (a connection positioned at a base may declare otherwise than one walking to it), where they were read from its credential's alone.
  - Why: before, such a listen was named in a warning and watched nowhere. A filter on a parent changes only when the parent does, so it is re-checked on the module's cadence, and a filter that matches too much is refused by name rather than costing a poll per record.
- `listen-fire serve` subscribes for the arrivals on an edge the module pushes to the connection or per scope (`delivery: connection` or `scope`, adapter protocol 2.6): one webhook per connection, position, edge, filter the module takes and scope, shared by every traversal listen on it. Before, a traversal listen on a pushed edge registered no webhook.
  - The call is `ensureEventSubscription({ edge, filter?, scope?, callbackUrl, current? })`. `removeEventSubscription` and `refreshEventSubscription` name the same `edge`, `filter` and `scope`, and so does the registration anew of one that lapsed.
  - Each webhook has its own door (`/api/public/webhook-sync/<provider>/<credential>/edge-<16 hex>`) and secret, kept in the credential's `edge_subscriptions`. An arrival delivered there is judged only against the listens sharing that webhook, so a filter the module applied for one listen never decides another's. An event delivered there reaches no listen of the settings form.
  - A webhook no listen shares any more is removed when the files change, as a settings-form webhook is.
  - The settings form's webhooks (`ensureEventSubscription({ events, callbackUrl, current?, scope? })`) are unchanged.
  - Why: what a module pushes is paid for per subscription, so the listens on one edge share one, and each delivery is judged by the listens it was asked for.
- A module can declare that a field of what lands on an edge takes the text literals the write wrote at a path, with `literalsFrom` on the edge's reference: `[{ "at": ["Actions", "Value"], "from": "Buttons[].Value" }]`.
  - After `msg = write ch-[:Messages]-> { …, Buttons: [{ Text: "Pursue", Value: "pursue" }, { Text: "Pass", Value: "pass" }] }` and `i = await msg-[:Interactions]->`, the `Value` of each action `i` carries is `"pursue" | "pass"`.
  - Comparing it against a value no button offered is refused (`MOV_ENUM_UNKNOWN_VALUE`, with a did-you-mean).
  - A value at that path that is not a text literal, such as a name, leaves the field its declared type, with a warning (`MOV_WRITE_GENERIC_UNTYPED`) naming the path.
  - A write that sets the path with no values, such as `Buttons: []`, is told so with a warning (`MOV_WRITE_LITERALS_EMPTY`): no answer can carry a value from it, and the field keeps its declared type.
  - A module's `literalsFrom` is refused when its schema is read if `from` does not parse, if `at` names no field of the landing, if the edge or a reference on the way lands on more than one type, or if the field is not a single text field.
  - The catalog snapshot carries it on `EdgeSchema` as `literalsFrom?`, an optional member.
- The check's answer to the engine (`check.program`) carries two more stamps, which an embedder that answers it passes on as it passes the others:
  - `opensWaits: [edge…]` where a record enters the run (a bound write, a binding that reads records, a traversal block's head, a function's parameter) and the program awaits those edges off records of its type, in any file it links;
  - `listsFirst: true` on a plain `await` of an edge that can also be listed.
  - `carriedAwaits: { <record type>: [edge…] }` on the parameter of a function a listen fires: the edges the program awaits off each record type the listen's arrivals carry. It is the host's, which opens those waits as it keeps a delivery; the engine passes it over.
  - The engine refuses any of them on a node it does not fit, as it refuses the others.
- The store keeps a run's waits on listenable edges, and a log of the arrivals modules report on them.
  - A wait reads what was logged after a mark taken before the write that may answer it, so an answer that arrives while the write is still running counts.
  - Each arrival counts once per wait, by its identity and version. Without a version, a record counts only when it is created.
  - A wait keeps, per record, whether the record matched its `WHERE` last time, so an arrival counts when the record newly matches.
  - Every arrival is kept an hour, and longer while a waiting run reads it; the drain forgets the rest, as it forgets old deliveries.
  - Store modules (a change to the store slot): six new methods, `waits.mark`, `waits.log`, `waits.open`, `waits.arrivals`, `waits.note` and `waits.sweep`; `parks.commit` takes `{ kind: "wait", waitId }`. `waits.log` queues a `wake_await` row per wait it answers in its own write, so an arrival pushed to the `wake` door loses no wake to a crash between the log and the rows. A store module must serve them for a run that awaits a listenable edge; the drain still runs over one that does not, and sweeps no arrivals there. The cases every store is held to are `packages/engine-contracts/conformance/store-waits.json`. See `docs/contracts/store-slot.md`.
  - A Postgres store gains `lf.arrival`, `lf.wait_row` and `lf.wait_seen` (migration 9): run `listen-fire connect @lf/postgres-store` once to apply it.
  - Why: a wait that registers only when it is reached misses an answer that comes back during the write that asked for it.
- Adapter protocol 2.5: modules report arrivals, and `listen-fire` logs them. `listen-fire --version` reads `adapter protocol 2.0–2.5`.
  - Store modules: `inbound.keepDelivery` may carry the delivery's `arrivals`, logged in its write after the receipt, and answers the wake rows it queued (`wakes`). A store module whose manifest lists no `waits.log` keeps no arrivals: a delivery that reports some is refused before anything of it is kept (503 `arrivals_not_kept`, naming the module and `waits.log (adapter protocol 2.5)`), so its sender sends it again. See `docs/contracts/store-slot.md`.
  - An arrival reported again with the same identity and version on the same record's edge within the hour is logged once (`waits.log` skips the repeat), so no retry wakes a run twice. One without an identity is never a repeat.
  - A module with listenable edges answers `awaitKeys`: the key each record's edge is waited on under, read off the records alone.
  - It reports what lands there as arrivals, each naming its edge, its record's key, its identity and its landing: beside the events `preprocessInbound` answers for a delivery, on `checkInbound`'s `accepted` (`accepted(events, { arrivals })` in the module kit), or pushed to the `wake` door as `{ arrivals }`.
  - `listen-fire` logs each one and queues a wake for each run waiting on that record's edge. A delivery's arrivals are logged in the same write as its receipt, so a redelivery logs and wakes nothing again; its events carry the log's mark after them, so a run the delivery starts never waits for the delivery's own arrivals.
  - An arrival without an identity is refused, naming it: `arrival 0 on 'Comments' has no identity` (400 at the `wake` door; the delivery's failure otherwise).
  - The acme example's CRM answers `awaitKeys`, pushes each comment as an arrival, and reports the comments a webhook delivery carries, each by its id.
  - Why: a waiting run reads the arrivals logged since it began waiting, so one that lands during the write that caused it is never lost, and whether it matches is decided by `listen-fire`, not the module. See `docs/contracts/adapter-protocol.md` ("Waiting on your system").
- `@lf/slack`: a message can carry buttons, and a run waits on the message for a press.
  - `Buttons: [{ Text: "Approve", Value: "approve" }, …]` on a message write posts the text with one button per entry. Buttons are never written with `Blocks` or `File`: the check refuses it, and so does the module (`a Slack Message's Buttons can't be combined with Blocks or File`). They need the `Message` text. The module refuses, naming the field, a button without its `Text` or `Value`, and Slack's limits: at most 25 buttons, 75 characters on a label, 2000 in a value, and 3000 of `Message` text above them.
  - `press = await msg-[:Interactions]->` waits for a press on the message. A press is an `Interaction { Id, At }`, its `Actions` the controls used (`Action { Value, Text }`) and its `By` the member who pressed. `only(press-[:Actions]->).Value` is one of the `Value`s the buttons were written with, so a comparison with one never offered is refused (`MOV_ENUM_UNKNOWN_VALUE`). A press on a control in `Blocks` arrives the same way, its value unchecked.
  - `await msg-[:Replies]->` takes the first reply already in the thread, oldest first, or else the next to arrive; `await new` only the next. A reply that mentions the app counts once, though Slack sends it twice.
  - A deleted message leaves both waits waiting: race them with a `sleep`.
  - The module moves onto adapter protocol 2.5: `awaitKeys` names a message by its channel and `ts` (a thread by its root), and presses, thread replies and deletions arrive with the inbound delivery as arrivals. It no longer offers `resolveAwait` or `wakeKeys`, and states protocol minor 5.
  - Why: the expense approval that needed two callbacks, their ids in Block Kit JSON and a result slot each is a write with buttons and one wait on the message.
- The webhook door reads a delivery sent form-encoded (`application/x-www-form-urlencoded`) as well as JSON. Its signature is checked over the raw bytes, and the module reads the form's fields: each is text, and one sent more than once is the list of its values. Why: Slack posts a press on a message's control as `payload=<json>`, verified with Slack's own signing secret, at the same door as its events.
- A Slack delivery (`slack_v0`) whose `x-slack-request-timestamp` is more than five minutes from now is refused 401, on `listen-fire` and the platform alike. Why: Slack's own advice; without it a captured request could be replayed for ever.
- `listen-fire serve` prints the door of every connection a program makes to a module that announces arrivals (`awaitKeys`), as well as those a listen names. Why: a press on a message's buttons, or a reply a run awaits, reaches the run through that door, and a project that only waits on Slack (no Slack listen) had no door printed to point Slack's Interactivity and Event Subscriptions at. The Slack handbook section says to point both there.
- On `listen-fire`, a delivery to a connection's door (`/hooks/<module>/<credential>`, the URL `listen-fire serve` prints) is verified with the install's webhook secret when the credential holds none of its own, for every signature scheme. Before, only a module that checks its own inbound fell back; a Slack connection's door, whose signing secret `listen-fire connect` puts on the install, refused every delivery.
- A module can declare that what lands on an edge is typed by a node the write names, with `answerShapeFrom: "<field>"` on the edge's reference. The field is a writable `json` field of the record the edge hangs off.
  - After `node Refund { Approve: <boolean>, Note: <text | null> }`, `form = write forms-[:Forms]-> { Title: "…", Fields: Refund }` and `s = await form-[:Submissions]->`, `s.Approve` is a boolean and `s.Note` is text or null, beside the landing's own fields. Comparing `s.Note` with a number is refused (`MOV_COMPARE_TYPE_MISMATCH`), and reading a field the node does not declare is refused (`MOV_UNKNOWN_PROPERTY`).
  - The field must name a node declared in the file, or a second name for one: `Fields: { Approve: true }` is refused (`MOV_ANSWER_SHAPE`).
  - The node cannot declare a field the landing has already: `node Refund { Id: <number> }` against a landing with an `Id` is refused at the write (`MOV_ANSWER_SHAPE`), naming the field.
  - The module receives the node's fields as that field's value, `{ "fields": { "Approve": "boolean", "Note": { "kind": "maybeAbsent", "of": "text" } } }`: the check stamps them on the field's value (`nodeSchema`, a new stamp in `check.program`'s answer, which an embedder passes on as it passes the others).
  - A module's `answerShapeFrom` is refused when its schema is read if it names no field of the type the edge is on, or one that is not a single writable `json` field, or if the edge lands on more than one type.
  - The catalog snapshot carries it on `EdgeSchema` as `answerShapeFrom?`, an optional member.
  - Nothing in the language knows a form: the edge names the field.
- `@lf/forms`: a form at a link, answered once. `forms = connect forms_module` (no credential), then `form = write forms-[:Forms]-> { Title: "Approve the refund?", Fields: Refund }` makes a form whose fields are the `Refund` node's; `form.Url` is its link, and `await form-[:Submissions]->` waits for its answer, typed by `Refund`.
  - The link is the module's door under `listen-fire serve`, at lf.yaml's `publicUrl` (or `listen-fire serve`'s own address), with an unguessable id. A browser gets the form; `Accept: application/json` gets `{ title, fields }`, each field's `type` and `required`.
  - A POST of JSON or a form records the answer once (200 `{ "outcome": "recorded" }`). A value of the wrong kind is answered 400 `{ "outcome": "mismatch", "message": "'Approve' must be true or false" }` and records nothing; a different second answer is answered 410 `{ "outcome": "answered" }`; a link to no form, 404.
  - The same answer posted again is the same answer: reported again under the same identity. Why: the host refuses to keep an answer its store cannot keep (503), and the sender's retry must not then be told the form was answered.
  - A form is written, never listed (`Form` is not readable): its link is all that guards it, so only the program that wrote it holds it.
  - A form never expires: a wait on a person sits in a `race` with a `sleep`.
  - Why: an answer that comes back through no system the program uses needs somewhere to be given, and a module serves it as any module serves its door.
- A module that checks its own inbound requests may answer a page (`reply(status, { html })`, sent as `text/html`), and may name what the door answers once it keeps an accepted request (`accepted(events, { arrivals, reply })`), in place of the door's own acknowledgement.
- `listen-fire` sends each call to a module that takes inbound requests the URL they reach it at (`inbound: { url }` on the request, module-kit's `ctx.config.inboundUrl`): the install's door under lf.yaml's `publicUrl`, else under `listen-fire serve`'s own address. A module hands out links to itself with it.
- A module's acceptance's `reply` is refused by `listen-fire` unless its status is a success (200–299), as the adapter protocol and the TypeScript client say.
- A module `listen-fire` starts keeps its `ctx.kv` in its own folder (`.lf/externals/<name>/`) unless its install names another `MODULE_STATE_DIR`. Before, `ctx.kv` refused unless the install named one.
- `listen-fire modules` lists every module this `listen-fire` can install, the bundled `@lf/*` ones, with a line on what each is and which the project has installed. A bare `listen-fire connect` prints the same list; it listed only the slot modules and what the project already held.
- `listen-fire modules show <module>` summarises one module in a screenful, read from the module itself: the record types it reads with their fields and edges, whether it writes (`@lf/stripe` is read-only) and what, the events a `listen` can name, its credential and settings, and the `connect` flags it needs. It needs no credential. A module whose schema comes from the connected account says so instead of describing: its manifest now says `introspectedSchema` (an optional field of the adapter protocol's manifest, set by Airtable, Attio, Affinity and Google Sheets). `--json` gives the same facts.
- `listen-fire connect <module> --yes` asks nothing. Each answer comes from a flag (`--setting <name>=<value>`, `--server-secret`, `--webhook-secret`, `--client-id`, `--client-secret`, `--redirect-port`) or from its default, and a webhook secret is generated and said to be. When an answer has neither, the command names every flag it needs and writes nothing. Before, `--yes` still asked: with no terminal it hung for input or failed with "the input ended before every question was answered", and left no external behind. Without `--yes`, questions are still asked, and input that ends names the flag that would have answered.

- `listen-fire` breaks loops itself: a chain of writes and arrivals longer than `lf.yaml`'s `loopDepth` (default 10) runs pauses the listen that would continue it, by name.
  - A run's writes can fire more runs: a two-way sync hears its own write come back, and two automations can feed each other. `listen-fire` keeps each record write a run sends, the moment its module answers it (the store's write ledger, `writes.record` and `writes.depth`; `@lf/postgres-store`'s migration 14).
  - An arrival on a record a run wrote at most `loopWindow` (default `20s`) before it happened continues that run's chain. It is matched by the record it is `about` and by its landing; it is measured to its `occurredAt` (adapter protocol 2.6, new), the time its provider stamped, so an echo a poll finds late is still the write's; one without is measured to when `listen-fire` takes it.
  - The listen whose arrival would start run `loopDepth + 1` is paused: "LISTEN_LOOP: <file>:<movement> is paused: this arrival would start run 11 of a chain of writes and arrivals (<run ids, oldest first>); \`listen-fire listens resume <file>:<movement>\` once the loop is broken" (with the default depth). While it is paused, each arrival it would run is said (`held: the listen is paused (LISTEN_LOOP)`), counted and not run: `listen-fire listens` shows the count (`paused: LISTEN_LOOP: …; 3 arrivals held and not run`), and `listens resume` clears it and lets the listen fire again. A held arrival is not run on resume: a run then would start a chain of its own and the loop would go round again. `listen-fire runs show` lists a run's `chain`. A store that cannot answer or keep the write ledger fails loudly (the delivery is tried again; a write's call fails after the write was sent): the breaker is never silently off.
  - A write that would change nothing is still not sent where the module lists `readRecord` (its outcome is `noop`), so a two-way sync's echo writes nothing and its chain ends: Affinity, Airtable, Attio, Dealroom, Evertrace, Gmail and Google Sheets read a record back; Slack, Stripe, GitHub, Granola, Telegram, WhatsApp, email and webhook do not.
  - Why: `suppress_self` leaves the language; the host protects every listen from loops, guard or none, and a loop that would run forever stops loudly. An arrival seconds after a write is the write's; later, a person more likely acted.

#### Removed

- `cron`, `manual`, `@lf/email`, `@lf/webhook`, `@lf/github`, `@lf/gmail`, `@lf/granola`, `@lf/dealroom`, `@lf/evertrace`, `@lf/stripe`, `@lf/attio`, `@lf/affinity`, `@lf/airtable`, `@lf/telegram` and `@lf/whatsapp` declare no `listenConfig`, `subscribableEvents`, `fires` or event types: each listens on its edge.
- `callback(…)` is retired.
  - Each one is refused where it is written (`MOV_CALLBACK_RETIRED`, an error), naming what replaces it.
    - For a form a person opens: a form from `@lf/forms` (`form = write forms-[:Forms]-> { Title: …, Fields: … }`), its `form.Url` sent, then `await form-[:Submissions]->`.
    - For buttons: `Buttons: [{ Text: …, Value: … }]` on the message, then `await msg-[:Interactions]->`.
  - A callback that takes many answers (`once: false`) becomes a standing `listen` on the message's `Interactions`, one run per answer, keeping its state in a table; the message says so.
  - A callback's `ttl` becomes the program's `race` with a `sleep`.
  - The binding keeps its old type, so a read of its `.id`, its `.url` or its `Called` edge raises nothing more.
  - `listen-fire upgrade` from a 0.12 pin lists each one by file and line, and leaves the pin where it was until each is replaced by hand.
  - `MOV_CALLBACK_NOT_MOVEMENT`, `MOV_CALLBACK_BAD_CONFIG` and `MOV_CALLBACK_PARAM_NOT_VALUE` are raised by nothing; their names are not reused.
  - Why: a callback was a second way for a run to wait, outside the graph. A form and buttons are records on edges, and a run awaits them like any other.
- The host machinery for callbacks went with them.
  - `listen-fire call` exits 2, saying a run waits on a form from `@lf/forms` instead.
  - `/api/cb/<id>` answers any request 410 `{ "outcome": "retired", "message": … }`: a link minted by an earlier release is gone for good.
  - The engine refuses a `callback(…)` that reaches it, as one the checker should have caught.
  - Store modules: `listen-fire` no longer calls `callbacks.*`, `correlations.*` or `records.closeRun`, and `parks.commit` takes no `{ kind: "await" }` park.
  - The SQLite state file drops its `callback` and `await_correlation` tables. `@lf/postgres-store`'s migration 10 drops `lf.callback` and `lf.adapter_await`: run `listen-fire connect @lf/postgres-store` to apply it.
  - Embedders: the host families lose `park.callbacks`, `fireCallbackBody` and the run input's `fire`, and `park.sink.commitAwaitPark` and `park.wake` take a `waitId` only. The Rust embed loses `fire`, `CallbackCall`, `CallbackMint`, `MintedCallback`, `AwaitPark`, and the store's `mint_callback`, `callback_calls`, `commit_await_park` and `wake`.
  - A run parked on a callback under 0.12 cannot resume on 0.13, as no run parked under 0.12 can.
- `listen-fire` no longer wakes a waiting run by key.
  - It calls neither `resolveAwait` nor `wakeKeys`, ignores a `checkInbound` acceptance's `wakeKeys`, and queues no `wake_await` row by key: modules report arrivals (adapter protocol 2.5).
  - The Rust module kit's store slot loses `correlations.*` and `callbacks.*`.
- The engine package's host (`@listen-fire/engine`, `@listen-fire/engine-contracts`) moves to host families version 2, as the Rust embed did.
  - `EngineHost.park.waits` (`mark`, `open`, `arrivals`, `note`) serves a run's waits, and the in-process host passes the waits it is given to the engine. `park.sink.commitAwaitPark` and `park.wake` take a `waitId`. `RunInput.triggerMark` names the arrival log's mark where the delivery that started the run was kept.
  - Gone: `park.callbacks`, `fireCallbackBody`, `CallbackBodyInput` and a host recording's `callbackBody` entry (the recording format is version 3; a version 2 recording still reads unless it records a callback body, which is refused by name); an adapter's `awaitable` capability (`resolveAwait`) and `wakeKeys`, and the remote adapter's forwarding of both. A remote module that offers `awaitKeys` is asked it.
  - The story analysis's body kinds no longer list `callback` (docs/contracts/story-analysis.md).
  - The inbound doors (`answerDelivery`, `answerWake`) hand what a delivery says arrived to the store's `logArrivals`, in place of `enqueueWakes` by key. A delivery's arrivals are logged only once all its receipts are queued: a receipt that cannot be queued fails the delivery (500) with no arrival logged, as `listen-fire` keeps both in one write. The `wake` door takes `{ arrivals }` and refuses `{ keys }` (400, naming adapter protocol 2.5 and `arrivals`), as `listen-fire`'s does. A module's acceptance that names a `reply` is answered with it once the delivery is kept, in place of the door's acknowledgement.
  - Why: a host built on the engine package serves the same contract as `listen-fire`, so a run waits on arrivals there too.
- The engine package's run host (`@listen-fire/engine`'s `public/run-host`) waits on arrivals, as `listen-fire`'s does, and keeps no correlations or callbacks.
  - The store (`RunHostStore`) gains `waits` (`mark`, `log`, `open`, `arrivals`, `note`, `sweep`) and `parks.commit`, which parks a leaf and what wakes it (a timer's row, or the wait parked at its address) in one write. `memoryRunHostStore` keeps them, and passes every case of the waits cases `listen-fire`'s stores pass (`storeWaitsCases` in `public/testing`, over `conformance/store-waits.json`), with the run rows they keep beside it (`RunRowStore`). It also gains `parks.commitSegment` and `parks.owedRaces`, as `listen-fire`'s stores keep them; a park's `teamId` names the tenant a timer's row is queued under.
  - `runParkHost` gives a segment its `park` group: the sink, the run's waits (a note names the leaf the segment resumed and is fenced by its lease) and the wake the engine asks for. `logArrivals` logs what a module reported and queues a `wake_await` row per wait it answers, in the log's one write (`waits.log`); `sweepArrivals` forgets what was logged more than an hour ago that no wait reads, which a product calls on its schedule, as listen-fire's drain does (an embedded host's `tick` does); `wakeWait` re-enters the await a row names, under the run's lease.
  - A race an arm wins is owed durably, as `listen-fire` owes it: the step's end (`parks.commitSegment`) finishes the arm's leaf and queues a `settle_race` row in one write, the drain settles each race the run owes, and the step that settles one discharges its row. A drain that dies between leaves the race to the run's next drain (`drainOwedRaces`, for a `settle_race` row), and a run that owes a race is never complete. `drainRun`, `drainDueTimers` and `wakeWait` take the run's `teamId`. Why: the race was kept only in the drain's memory, so a drain that died before settling it left its run parked for good.
  - A row whose drain lost the run's lease goes back due rather than done, on this host and on `listen-fire`'s: the next holder's lease claim parks the leaf the drain claimed again, and only that row's retry steps it on; a `settle_race` row so lost keeps its race owed. A step that ends its run answers the run's settle (`StepOutcome`'s `settle`), and the drain writes it in the step's end, so a crash never leaves a run parked with nothing left to wake it. `WorkQueue.release` takes the store slot's `why`: a row released because its run was held elsewhere, or because it was never stepped, goes back `busy`, which a store module does not count as an attempt.
  - Gone: the `correlations` family, `CallbackStore`, the callback rules and contract cases, `AwaitKeeper` and `RunHost.keepers`, `RunRecords.closeRun`, `runParkSink`, `queueAwaitWake`, `wakeAwaits` and `drainAwaits`; `engine-contracts`' `callback` vocabulary (`CALLBACK_AWAIT_TYPE`, `CallbackParamSpec`, `CallbackCall`).
  - This host writes each park as the engine makes it, where `listen-fire` holds a segment's parks to its end (host-families.md allows both). A segment that dies after parking one arm of a `parallel` leaves that arm parked, and its resumed leaf is resumed again.
  - The inbound doors' `capture` and `enqueue` are idempotent per receipt: a delivery whose receipts were not all queued is answered 500 and its retry queues each event once (a store keys a receipt on the event's `externalId`). Each receipt is its own write here, so the guarantee beside `listen-fire`'s one write is the order: arrivals are logged only after every receipt is queued.
  - `@listen-fire/embed`'s host takes arrivals (`arrive(tenant, { adapterType, arrivals })`), and a run that awaits a listenable edge parks until one lands; `arrive` steps the arriving tenant's woken runs only. `tick` steps woken runs, due timers and owed races. Where a run stands is its run row in the store's `runHost`, which serves `RunRowStore` too: a park marks its run parked in the park's own write, and the step that ends a run settles it in that step's end; `EmbeddedRun.status` is gone. It needs `@listen-fire/engine` 0.13.0.
- A run a delivery starts waits on its trigger from the moment the delivery is kept, and the arrival log is swept per record.
  - A delivery's runs are minted as it is kept, and each opens the waits its function awaits off its trigger in the same write, reading from the mark before the delivery's arrivals. A reply that lands while the run sits in the queue, or later in the same delivery, answers it. Before, a run counted from when it started, and missed those.
  - A poll of a listenable edge that fires a listen is kept the same way, as a delivery of its own (`listen-fire deliveries` lists it with the source `poll`): its cursor, its arrivals and one queued row for the runs it fires go in one write, and a comment the same page carries answers the run its note starts. Before, a run a poll started read from after the whole page, the runs started inside the poll, and the cursor was saved after them, so a poll that died between was polled again and missed that comment. A poll's runs are judged only against the listens sharing the poll that it fired.
  - What a delivery to `/hooks/<module>` (or `listen-fire run --webhook`) lands for the listens on a traversal is kept as a queued row too, which the request runs and completes; one whose process dies is run by a drain a minute later. Before, a sweep while the request started its runs could forget an arrival they were about to read, and the runs of a request that died were lost.
  - A queued delivery that is retried keeps the runs its first attempt started. Before, the retry dropped their waits and leaves, and they never resumed.
  - Only the trigger's own arrival is kept from answering its run, matched by identity. Before, every arrival of the same delivery was, so a provider that batches a note and a comment on it into one request lost the comment.
  - An arrival is forgotten once no live wait on its record reads it and it is at or below the floor: the lowest mark a running step's lease took, else the latest. Before, every arrival was kept an hour, so a step slower than that could lose one it was about to read. `@listen-fire/embed` holds each step's mark in its process (a run it starts takes no lease), so its `tick` never forgets an arrival a starting run is about to read.
  - An arrival's identity is kept apart from it for the module's re-send window, so a provider's re-send after the arrival was forgotten is still a repeat. A module declares the window (`resendWindowSeconds`, an hour when it declares none; `@lf/stripe` declares three days), and lf.yaml's `resendWindow: { <module>: <duration> }` overrides it.
  - Store modules (a change to the store slot, which a store module must take): `waits.sweep` takes `{ limit, floor? }` and answers `{ swept }` (`floor`: a mark the caller's own steps hold, above which nothing goes); a delivery's `source` may be `poll`; `waits.log` takes `resendWindowMs`; `leases.claim` keeps the arrival mark it was claimed at; `work.completeKey` completes a row its caller ran itself; `inbound.keepDelivery` refuses `waits` sent without `arrivals`; `inbound.keepDelivery` takes the runs' `waits` and answers `arrivalMark`, the mark before the delivery's arrivals (a `fire_event` row's `arrivalMark` was the mark after them); `work.bury` of a `fire_event` row drops the waits of the runs it queued that never started. The Rust module kit's `Store` trait gains the members these need, and `listens.*`, so a store module built on it no longer compiles until it serves them. A Postgres store applies migration 13 (`listen-fire connect @lf/postgres-store`).
  - The engine package's inbound door keeps a delivery in one write: `InboundStore`'s `saveCheckpoint`, `enqueue` and `logArrivals` become `keepDelivery`, which mints the runs and opens their waits. The push store's `logArrivals` becomes `keepArrivals`. Its run host's `sweepArrivals` takes no `now` and may take the marks a host's steps hold (`heldMarks`), and `logArrivals` takes the module's `resendWindowMs`.
- The Telegram and WhatsApp handbook sections, and their `Reply Markup` and `Interactive` field descriptions, teach a url button that opens a form from `@lf/forms`, in place of a callback id on the button.
  - A `callback_data` or reply button's tap reaches no run until those modules report taps as `Interactions`, as Slack does.

#### Checks

- A stated landing type names a declared node (`MOV_UNKNOWN_TYPE_NAME`), types only a landing its module leaves untyped (`MOV_LISTEN_SHAPE_MISMATCH`), and the fired parameter must be assignable to it (`MOV_LISTEN_SHAPE_MISMATCH`, `MOV_LISTEN_PARAM_MISMATCH`). A function typed by a node on an untyped landing whose type the listen does not state is refused, naming the annotation to write (`MOV_LISTEN_PARAM_MISMATCH`).
- `MOV_LISTEN_SETTINGS_RETIRED` rewrites a `type` key (`payload: <Payment>`) as the stated landing (`-[:Requests]-><Payment>`), and a listen with no settings (`listen to manual fire f`, `listen to x {}`) as the module's mapped edge. It offers no rewrite whose path would range over an unbounded edge with nothing on a field that bounds it (a keyless email listen).
- Two checks stay warnings in 0.13.0, where earlier notes said this compatibility key would refuse them: a value handed to a plugin outside the type it declares (`MOV_CALL_ARG_TYPE`, as 0.12.10 said), and a text in a list an enum is tested against with `IN` (`MOV_ENUM_UNKNOWN_VALUE`, below). Refusing them is left to a later compatibility key.
- A dot read off a record reads one field, whole; anything past it is refused, where it checked clean and then failed the run with `MOVENG_UNSUPPORTED` ("this read shape … is not supported"). Refused, since no such read could ever run:
  - a name the record lacks, read on past (`n.subject.title`): `MOV_UNKNOWN_PROPERTY`, naming the record's fields and its edges;
  - a text, number or true/false field read on past (`n.Title.length`): `MOV_TEXT_HAS_NO_FIELDS`;
  - any other field read on past (`c.Metadata.crm_id`): the new `MOV_READ_THROUGH_FIELD`, whose remedy is to bind the field first (`metadata = c.Metadata`, then `metadata.crm_id`), which runs.
  - except a field that holds a record (below): `c.Current.Stage` reads on through it, typed by the record's type.
- An edge read as a field (`n.Repository`) says it is an edge and shows the walk (`n-[:Repository]->`, or `n-[:Repository]->.Name` for `n.Repository.Name`). A field a record lacks (`MOV_UNKNOWN_PROPERTY`) now lists the record's edges after its fields.
- A text in a list an enum is tested against (`n.Reason IN ["review_request", "mention"]`, or `List.includes([…], n.Reason)`), in a body or in a WHERE inside a parameter's type, is held to the enum as `==` holds one: `MOV_ENUM_UNKNOWN_VALUE`, with a did-you-mean. A warning, since the list's other values still match and a program runs as written; refusing it is left to a later compatibility key.
- A statement word bound as a name (`link = …`, `write = …`, `delete = …`) is refused as "'link' is reserved; pick another name". It was refused before as a malformed statement, naming the arrow it expected.
- A type's address that names no position in the graph is refused where it is written (`MOV_UNKNOWN_POSITION`), saying what was looked for. Against a base with no table "Expenses", `<finance-[e:`Record Change` WHERE e.table == "Expenses"]->>` says `'finance' (base "Finance") has no table "Expenses"`. It checked clean and left the parameter untyped, so a misspelled field read off the event's record (`expense.Amout`) went unchecked too. Refused: a listen on a table that does not exist never fires, so no released program with such an address ran correctly.
- A parameter type whose hop onto records carries a `WHERE` (`<crm-[c:Companies WHERE c.Stage == "Open"]->>`) is typed as those records, since a `WHERE` picks records and does not change what they are. It was untyped, and a read of a field the records lack went unchecked.
- A hop whose `WHERE` the connection's members answer, and that selects none of them, is refused where it is written (`MOV_UNKNOWN_POSITION`), naming the members there are with a did-you-mean: `pipeline-[b:Base WHERE b.Name == "Pipeline Trackr"]->` says `'pipeline' has no Base whose Name is "Pipeline Trackr" — it has: "Pipeline Tracker", "Ops" — did you mean 'Pipeline Tracker'?`. Only `listen-fire check` publishes what such a hop selects (a catalog's `unselected`); a catalog without it checks as before.
- `listen-fire upgrade` from a 0.12 pin warns on each `await` on a record's edge that no `sleep` races (`MOV_AWAIT_MAY_HANG`): one not inside a `race` arm whose sibling arm reaches `await sleep(…)` (directly or through a function it calls) and cannot itself wait forever. A wait in a function is raced when every call of that function is; otherwise it is warned once, at the unraced call where the run comes in, spelling the calls down to the wait (`asked(msg) → pressed(m) → await m-[:Interactions]->`). Under 0.13 such a wait whose record is deleted waits forever, where under 0.12 the code after it was skipped. The warning shows the race to write; there is nothing to rewrite for you, so it never holds the pin.
- No traversal ranges over an edge its module declares unbounded (`bounded: false`, such as every cron schedule or every team's mail). A read, a wait or a listen over one needs a `WHERE` with a filter the module takes on one of its `boundedBy` fields, written `==` or `IN [ … ]` with literals; anything else is refused (`MOV_UNBOUNDED_EDGE`), naming the fields and showing the filter to write: ``'-[:Ticks]->' is unbounded: cron can narrow it only by Schedule written `==` or `IN [ … ]` with literals, and this hop has no WHERE. Narrow it: `-[t:Ticks WHERE t.Schedule == "…"]->` ``. This holds off a record that may be absent, and off one that may be any of several types (each type's edge is checked). Why: the host would otherwise list or poll the whole edge, which no module can serve.
- A hop's `WHERE` is split into its top-level parts (joined by AND) that the module takes and the rest, which is checked on what comes back. A part is taken when it compares one field of the landing with literals, by an operator that field takes, on an edge whose module filters (`native`); an OR of `==` on one field, or an `IN`, is taken when the field takes `in`. A part that compares with a value read off another record or a name the run holds is checked on what comes back, so what is taken is the same on every run. A part that reads an owned field and that the module cannot take is refused (`MOV_FILTER_NOT_TAKEN`), including one comparing it with something other than a literal, as are two `==` that give one owned field two different literals. The messages a read's `WHERE` already got (`MOV_HOP_FILTER_UNSUPPORTED`, `MOV_HOP_FILTER_RESIDUAL`, `MOV_HOP_FILTER_ENGINE`) are unchanged.
- A field of an owned kind (a scalar only its module evaluates, such as a cron schedule) is typed as that scalar, not as text: it compares and fits as text, and it is named by its scalar in messages (`Cron`). A text literal compared with one or written into one is checked as its module would (`MOV_OWNED_VALUE_INVALID`): a `Cron` is a five-field schedule, a `Zone` a time zone, any other the module's `allowPattern`. An allow pattern may now hold groups (`^[a-z0-9]+(-[a-z0-9]+)*$`), where before such a pattern checked nothing. This holds for an open enum's pattern too: a literal that fails a grouped pattern now gets `MOV_VALUE_UNLISTED`, a warning, where it got nothing.
- A read along a root collection its module only writes to or only announces on (`readable: false`, such as the example CRM's `Company`) is refused where it is written (`MOV_COLLECTION_NOT_READABLE`), saying it can be written to or listened to but not read. It checked clean and failed when the run asked the module to list it. A wait on a collection its module announces on is not a read.
- A listen on a traversal (`listen to x-[…]-> fire f`) is checked as a wait is, and refused where the host could not watch it:
  - its last edge must be one its module announces arrivals on (`MOV_LISTEN_EDGE_NOT_LISTENABLE`, naming one beside it that is), and every hop before it one its module lists (`MOV_LISTEN_HOP_NOT_ITERABLE`);
  - its `WHERE`s read only its own hops and literals (`MOV_LISTEN_IMPURE_WHERE`, naming what else is read: a name the run holds, `AI`, or a walk, inside `EXISTS` or not), since nothing from a run is there to read;
  - a filter on a hop before the last that what arrives does not carry, on a hop not cheap to list, is refused (`MOV_LISTEN_UNWATCHABLE`), with the way out: filter on what arrives, or wait on one record in a run;
  - what lands on its last edge must be assignable to the fired function's parameter, as an argument is to a parameter (`MOV_LISTEN_PARAM_MISMATCH`): a parameter wider than the landing (no filter) is accepted.
- A settings listen (`listen to gh { events: ["mention"] } fire f`) is retired in 0.13.0 for a traversal ending on the edge its events arrive on (`MOV_LISTEN_SETTINGS_RETIRED`), because a listen's settings were a second, unchecked way to say what a `WHERE` on that edge says.
  - Where its module declares how its settings map (`listenSettingsBecome`), the diagnostic carries the rewrite: `listen to gh-[n:Notifications WHERE n.Reason IN ["mention"]]-> fire f`, and the fired function's parameter typed as the 0.12 record retyped as the landing (`<gh-[:Notifications]->>`). A hop the connection is positioned on (an Airtable `base`) is left out.
  - `listen-fire upgrade` from a 0.12 pin applies it. With `suppress_self: true` or `every` the rewrite changes meaning, so it is listed and applied only by `upgrade --all`: a two-way sync's own echo now runs once more and finds nothing to change, and the module sets the poll interval (set `pollEvery` for the connection in lf.yaml).
  - A key the listen leaves out is compared with what leaving it out meant, where the module says so (`absent`; an inbox listen with no key heard the box's own mail, `e.Key == ""`). A module may also say its 0.12 keys were compared lowercased (`lowercase`), and the rewrite writes them so.
  - A key the module does not map, a value that is not a literal, a listen whose settings name nothing that bounds an unbounded edge, or a literal the field's owned scalar refuses has no rewrite and holds the pin until the listen is rewritten by hand; the message says which, and names the field that bounds the edge (`e.Key == "…"`).
  - On a `0.13` pin it is a warning while the modules move their listens onto edges; it becomes a refusal before 0.13.0 is released.
- A `race` or `all` slot holds the record its arm returns, typed as that record: a read of a field it lacks is refused (`MOV_UNKNOWN_PROPERTY`), and a comparison is held to the field's type. The slot was untyped, so `r[0].Missing` and `r[0].Note == 1` checked clean, and failed or misread at run.

#### Fixed

- A polled listen first polled by `listen-fire run --poll` is polled by every drain and by `serve` after it. Before, `run --poll` kept the listen's checkpoint without queueing its poll, and the drains took the checkpoint to mean the poll was queued, so the listen was never polled again, silently. The same holds for a shared poll of a listenable edge, and on a Postgres store a poll whose listens left and came back is armed again. An edge that declares `cursor: false` fires only what is new on the poll after its arming poll, not everything it listed before (the arming poll keeps a receipt for each listen and record it saw; an edge with a cursor keeps none, as its cursor holds the backlog back).
- A module with no install (no `module:`-only entry and no hand-written one) no longer takes the fields of a user's credential for it as its install's (the secret that signs its calls). `listen-fire` took the first entry naming the module when it had no install, which could be a person's own credential.
- `listen-fire connect` printed "installed <module> as externals/<name>" before the setup had written anything, so a setup that then failed (a missing answer) had said "installed" and removed the folder. It says so once the entry is written.
- `listen-fire check` with a credential Airtable refuses (a placeholder token) fails at once, where it hung for over two minutes saying nothing: `@lf/airtable` retried the refusal as if it were transient (its own changelog has the rest).
- A credential a module says the provider refused (`credential_refused`) whose refresh then fails is reported with both: what the module said and why the refresh failed (`credential "my_airtable" was refused — module "airtable" says: … — and refreshing it failed: the credential holds no refresh_token`), where only the refresh's failure was. A `check` that cannot read an external's schema names the external and the credential.
- `listen-fire check` warns on a position that names nothing the connection can see (`connect airtable using my_airtable { base: "Finance" }`: `MOV_CONSTRUCT_UNKNOWN_OPTION`, listing the bases there are), as the platform does. It said nothing, and the module quietly treated the connection as unpositioned.
- When the module fails a walk that `listen-fire` makes to type a signature's event address (a table's fields, or the tables a listen may name), the check fails and names the external and the walk, as a failed describe does. The failure was swallowed and the parameter left untyped.
- `listen-fire check` narrows a hop by its `WHERE`, as the hosted product does: `only(pipeline-[b:Base WHERE b.Name == "Pipeline Tracker"]->)` is that one base, its tables its edges, so `write base-[:Companies]-> { … }` checks against the Companies table's fields. It was refused as `MOV_LINKED_UNKNOWN_EDGE` ("pipeline.Base has no edge 'Companies'"), though Airtable's authoring hints say to reach a base this way. The WHERE is evaluated over the members the connection's walk hands over, the member it selects is walked to, and the tables its edges land on are walked to as well. A walk the module fails while narrowing fails the check, naming the external.
- A write off a record a hop's `WHERE` chose runs where it checked: `write base-[:Companies]-> { … }` off `only(pipeline-[b:Base WHERE b.Name == "Pipeline Tracker"]->)` creates the row in that base's Companies table. It checked, then failed at run with `MOVENG_RUNTIME: cannot infer the written type for edge 'Companies'`, because the record carries only its type (`Base`) and the run looked the edge up there. The check now hands the run the type it resolved the write to create (a `writtenType` stamp), so the two agree; `-[:Companies]-><Companies>` is no longer needed.

## [0.12.13] - 2026-10-29

A patch release of the 0.12 line: it reads the same pins as 0.12.0 (every `0.12.x`) and breaks no program an author wrote. The command is renamed to `listen-fire`, and two modules arrive: `@lf/github` and `@lf/stripe`.

### Changed

- **The command is now `listen-fire`, formerly `lf`.** `lf` is also a popular terminal file manager, which owns `lf` on Homebrew core, so the two collided on a PATH and in what people and models take `lf` to mean. `listen-fire` matches the crate (`cargo install listen-fire`), the domain and the Homebrew tap. Only the binary's name changed: every subcommand and flag is the same (`listen-fire check`, `listen-fire run`, `listen-fire runs show`). No `lf` alias ships.
  - Unchanged, so every saved project and program runs as it is: module names in movement source (`@lf/stripe`), the project file `lf.yaml` and the `.lf/` state folder, the `LF_*` environment variables, the release tags (`lf-v<version>`), the bundled modules' folder (`share/lf/modules`), the Postgres store's `lf` schema, and the crate and package names.
  - To move over: install again (the install script, Homebrew, or `cargo install listen-fire`), then delete the old `lf` where the earlier install put it: `~/.local/bin/lf` for the install script, `<prefix>/bin/lf` for `scripts/dist/install.sh`. Both scripts print a one-line note when they find an `lf` that an earlier install of theirs left; they never delete it.
  - Rename `lf` in scripts, CI jobs, cron entries and container commands. In Zed, the language server's settings key is now `lsp.listen-fire`.
  - A release archive carries `bin/listen-fire`. The install scripts refuse an archive from before the rename, which carries `bin/lf`.
  - The Homebrew formula is now `listen-fire` (`brew install listen-fire/tap/listen-fire`), no longer `lf`.

### Added

- New module `@lf/github`: your GitHub notifications, repositories, pull requests and issues.
  - A listen on `Notification` fires once per notification thread that is new or has changed since the last poll (review requests, mentions, assignments). `events` selects GitHub's reasons, and `listen-fire check` refuses one GitHub never sends. The first poll delivers nothing.
  - Polls are conditional, so an unchanged feed is a 304 that costs no quota, and never sooner than GitHub's `X-Poll-Interval`.
  - A notification leads to the pull request or issue it is about (`Pull Request`, `Issue`). A repository holds its `Pull Requests` and `Issues`; each holds its `Comments` and `Labels`. Field names are GitHub's.
  - Writes: a comment (`write pr-[:Comments]-> { Body: "…" }`) and a label (`write issue-[:Labels]-> { Name: "…" }`).
  - The credential is a personal access token. The notifications feed needs a classic one; GitHub serves it to no other kind.
- New module `@lf/stripe`: Stripe's events, and your customers, invoices and subscriptions. Read-only.
  - A listen on `Event` fires once per Stripe event delivered to the connection's URL (`/hooks/stripe/<credential>`) and signed by the endpoint's secret. A retry of the same event runs once. `events` selects Stripe's event types (the invoice, subscription and customer events), and `listen-fire check` refuses one Stripe never sends.
  - An event leads to the object it is about, typed: `Invoice`, `Subscription` or `Customer`. No hand-declared event node, no `data.object` to dig into.
  - Every amount is in major units of its `Currency`, by Stripe's own zero-decimal and three-decimal lists: 19.99 for 1999 cents, 500 for ¥500. ``Currency.formatFigure(inv.`Amount Due`, inv.Currency)`` is right for every currency.
  - Customers, invoices and subscriptions are joined by edges. `Email` on customers and `Status` on invoices and subscriptions reach Stripe.
  - The credential is an API key (a restricted read-only key is enough) and the webhook endpoint's signing secret.
- `@lf/webhook`'s `stripe` scheme and `@lf/stripe` check Stripe's signature with one shared check in module-kit. Nothing changes for a webhook connection.

## [0.12.12] - 2026-10-27

A patch release of the 0.12 line: it reads the same pins as 0.12.0 (every `0.12.x`) and breaks no program an author wrote. It fixes `lf serve` never becoming ready with an MCP connection imported, a regression in 0.12.11.

### Fixed

- `lf serve` and `lf serve --doors-only` become ready with an `@lf/mcp` connection imported (or any module that declares `hostLimits`). In 0.12.11 they printed nothing and never became ready: the module asked lf's limits door while lf described its connection at startup, and serve answered no request until that describe returned. Serve now answers the limits door from the moment it binds its port; every other request still waits until serve is ready. `lf run` and `lf drain` were not affected.

## [0.12.11] - 2026-10-27

A patch release of the 0.12 line: it reads the same pins as 0.12.0 (every `0.12.x`) and breaks no program an author wrote. It adds `lf runs rerun`, keeps a failed run's writes, and makes MCP connections retry.

### lf

- **`lf runs rerun <run-id>` runs a failed run again.** The rerun is the same run's next attempt, not a new run. It uses the event (or manual text) the run ran on, and the movement as the project holds it now, so a fix to the movement takes effect. It runs from the start. `lf runs show` lists every attempt with its status, times, writes and error; the run's status is its latest attempt's. Before this, an agent woken by a failure replayed the delivery, which made a new run every time (`lf deliveries replay` is unchanged, and its help now points here).
  - Only a run whose latest attempt failed is rerun. A succeeded, running or parked run is refused by name (`run <id> succeeded on attempt 2; nothing to rerun`), so a second rerun after one that succeeded sends nothing twice.
  - A failed attempt that committed writes before it failed is refused unless `--force`; the refusal lists each write (target and action).
  - A rerun holds the run's lease: of two at once, one runs and the other is refused. `--json` and exit codes as `lf run` (1 for a refusal or a failed attempt).
- **A failed run keeps the writes it made.** Its outcome (`lf runs show`'s `writes` and `writeRecords`) used to be replaced by the error alone; a write the run made before it failed, and one made by the segment that failed, are now listed. `@lf/postgres-store` now keeps `writeRecords` too (migration 8).
- **Store slot.** `runs.rerun { runId, input, at, fence }` starts a failed run's next attempt as one fenced write; a run row may answer `attempt` and `attempts`; `records.markFailed` keeps the writes in the run's outcome. A store module without `runs.rerun` still works, except for `lf runs rerun`, which fails with the module's "method not implemented" (docs/contracts/store-slot.md). The platform's store module needs `runs.rerun` (and run rows that answer `attempt` and `attempts`) before `lf runs rerun` works against it.

### Connectors

- **An MCP connection retries a request that failed in passing.** A 429, a 5xx or a network error is retried with exponential backoff and jitter (four attempts, at most 20 seconds of waiting), and a server's `Retry-After` is honoured. Reads (`initialize`, `tools/list` and tools marked read only) are retried on all of these. A tool that changes things is retried only where nothing can have happened: a 429, a 503 that carries `Retry-After`, or a connection refused or not found. A 401 or 403 names the credential. The connection declares that it reports throttles to the host, so every instance of the module slows down together.
- **`retryingFetch` in `@listen-fire/module-kit`** wraps a module's `ctx.fetch` with the same backoff for any module to adopt. The limits door now treats a 503 with a usable `Retry-After` as a throttle too (it was a 429 only), and a module that declares `hostLimits: true` without any `limits` of its own now has it kept (it was dropped silently). The `listen-fire-module-kit` crate's store table now serves `runs.rerun`, so a store module written in Rust can serve `lf runs rerun`.
- **The Gmail handbook** says "listen for both" where it said "ask for both" (`@listen-fire/gmail` 0.12.9); the assembled handbook keeps the word "ask" for approvals.

## [0.12.10] - 2026-10-27

A patch release of the 0.12 line: it reads the same pins as 0.12.0 (every `0.12.x`) and breaks no program an author wrote. Two new checks are warnings for every 0.12 pin and wait for the next compatibility key (0.13) to refuse: a value handed to a plugin outside the type it declares, and a plugin value outside its declared type at run time. The new refusals reject only text no released program could run correctly, or keys new in this release.

### Connectors

- **Airtable fires on one field's change.** A listen can name a field and the value it becomes (`field: "Stage", becomes: "Interview"`), and then fires only on that change. The fired movement's signature names the table (`function f(change: <hiring-[e:`Record Change` WHERE e.table == "tbl…"]->>)`); then the event's `Record` and `Old Record` are the table's rows, typed like the table (a select as its enum), and `Changed Fields` names what changed. `lf check` refuses `field` or `becomes` when the signature names no table, since nothing then describes the row (`MOV_LISTEN_BAD_CONFIG`, showing the signature to write). Webhooks created from now on ask for previous values and every field's current value, so `Record` is the whole row and a row's id reads as `Id`; an older webhook is registered anew the next time `lf serve` starts.
- **A new module, `@lf/webhook`,** takes incoming webhooks from any sender (Stripe, a form service, your own app). Each connection is one URL, `/hooks/webhook/<credential>`, which `lf serve` prints when it starts. The credential holds the signing scheme (`stripe`, `hmac-sha256` or `none`) and its secret; an unsigned, mis-signed or stale delivery is answered 401, and a retried one runs once. A listen can declare what its events are as a node the program declares (`listen to stripe { payload: <Payment> } fire \`Payment Failed\``): the movement's parameter and its reads are checked against that node, and under `lf` a delivery that fits no listen is answered 400 `payload_mismatch`.
- **`@lf/mcp` read tools** mark their required arguments as fields a read must pin in its `WHERE`, so `lf check` refuses a read that leaves one out (`MOV_HOP_PIN_REQUIRED`) rather than the run failing. Any describe may mark a field `pinned: true`; no other module does yet.
- **Gmail and Drive.** Gmail keeps drafts (opt-in at sign-in, under a second credential), and a listen can fire when a label is added to a message. Drive can copy a file into a folder. Their own `CHANGELOG.md` files have the detail.
- **WhatsApp** states who reaches a listen on either host: anyone, on the project's own number under `lf`; linked phones only, on the shared number.

### Embedding

An embedder's host is one call: `createEmbeddedHost`, in the new package `@listen-fire/embed`. It connects each tenant's modules over that tenant's own credentials, checks and keeps its movements, routes an event from the embedder's product to every listen that hears it (by connection, as `lf` routes), and steps on runs that sleep at each `tick`. The example SaaS's host integration went from 512 lines to 238. The routing rule is public in the engine (`listenerHearsDelivery`, `public/inbound`) and held to `lf`'s by a shared table of cases. A new package, `@listen-fire/authoring-mcp`, serves the tools an agent uses to write, check, save and run movements over MCP, for one tenant of the host that mounts it. See docs/embedding.md.

### Checks

- A value handed to a plugin is compared with the type the plugin declares for it: `fetchUrl(5)`, or a text where a list is taken, is a `MOV_CALL_ARG_TYPE` warning. A text naming none of a plugin's options is refused (`MOV_ENUM_UNKNOWN_VALUE`), as it already is for a function's parameter.
- A plugin's plain value reaches the program in the type it declares (a number as a number, a list as a list), where every value but a file arrived as text. A value outside the declared type is bound as its text, as before, and the run notes it.
- An unknown enum value is refused in two more places (`MOV_ENUM_UNKNOWN_VALUE`): each text in a list written into a list of enum (an Airtable multiple select), and a comparison inside a parameter type's `WHERE`. Such a program was writing or matching a value the field cannot hold.

### lf

- `lf` types a connection that names a position (`connect airtable using acme { base: "CRM" }`): the module's `positionArgs` reach the catalog and every call, so a base's tables are checked under `lf` as on the platform. A movement whose signature names its event's table reads that table's fields on the event, typed.
- A polled listen on a positioned connection polls in that position, under a checkpoint of its own. A webhook's scope takes what the listen leaves out from its connection's position: `listen to hiring { table: "tbl…" }` on a connection to base Hiring registers its webhook for that base, where it registered none.
- `lf credential add` for a plugin module prints the plugin import instead of an adapter's `connect … using …`.

### Protocol 2.4, and the minor a module states

Adapter protocol 2.4 lets a source whose event subscriptions lapse say when (`expiresAt` from `ensureEventSubscription`) and list `refreshEventSubscription`. `lf` refreshes each such webhook a day before it lapses: `lf serve` on its tick, `lf drain` where a deployment scales to zero. A failed refresh is printed once and retried in 15 minutes; a webhook that lapsed while nothing ran is registered anew. `@lf/airtable` lists the method, so a quiet table's webhook no longer lapses after 7 days; an older `lf` reads `@lf/airtable` as before.

A module's stated protocol minor is now what it needs its host to speak: what its author declares, else 0. The kits no longer raise it for the methods a module offers, since a host calls only the methods it speaks and checks for a method by name. Before, a store module offering `work.enqueueIfAbsent` stated 2.2 and an older host refused it for nothing; it now states 2.0. `lf --version` reads `adapter protocol 2.0–2.4`.

### Fixes from running `lf` on real projects

- A file a module owns (a Gmail attachment) can be read by an extraction or `File.read`: `lf` redeems it through the module, as a write already did. Before, the extraction saw nothing.
- A write to the movement's event parameter (`write company { … }`) updates the record the event fired on. It checked clean but failed every run.
- A field read off a name bound to a walk reads the records the walk landed on: after `row = change-[:Record]->`, `row.Stage` is the Stage, where it read as empty.
- `lf runs show --json` shows when a run finished (`finishedAt`) and lists its writes (`writeRecords`); `writes` counts every entry into the run, where a resume reset it.
- `lf` prints a line when a polled listen's first poll arms it (`gmail: inbox:invoice armed; it fires on changes from now`).
- A run's trace names each model call's `tier`, `model` and `effort`, so `quick` and `careful`, which share a model, read differently.
- An event that matches none of its module's event types (no `tag`, and no type's `match` fits its payload) names no record. When such an event's run fails, `lf run --event` now says so, naming the types' tags. The example project's `events/company_created.json` carries its `tag`.

## [0.12.9] - 2026-10-26

A patch release of the 0.12 line: it reads the same pins as 0.12.0 (every `0.12.x`) and breaks no program an author wrote. Two behaviours change for an existing project under `lf`, both from routing inbound events by connection:

- A webhook `lf serve` registers may move: it is now registered as the credential the listen's own `using` names, where it was the first credential for every connection. The old webhook is removed when no listen uses its credential.
- A delivery to a path with no credential (`/hooks/<external>`) now reaches the listens of the first hand-written credential only; `/hooks/<external>/<credential>` reaches that connection's listens, and the module's own install door still reaches every listen.

MCP servers connect as adapters: tools are typed per server and `lf` describes each connection as itself. Inbound events route by connection, each connection registering its own webhook. `lf connect` asks for an OAuth app only when no token alternative exists.

- `lf` types each connection of a module by its own schema: it describes the module once per credential the movement files import (`lf check` costs one describe per connection), as the hosted product does. A credential no file imports is not described, so a server it names that is down fails no check. Before, every connection was typed by the first credential's schema, so two workspaces (or two servers) of one module shared one set of types, and a field only one of them has could pass `lf check` on the other.
- A new bundled module, `@lf/mcp`, connects any remote MCP server over streamable HTTP: each connection names its server and signs in with a token or OAuth, and its tools become types that `lf check` checks (a tool that changes things is written, a read-only tool is read with its arguments pinned by the `WHERE`). See `modules/mcp/README.md`.
- `lf connect` no longer demands an OAuth app from a module whose users may sign in with a token instead (`@lf/attio`, `@lf/mcp`): it asks, no by default, and `--yes` sets none up unless the OAuth endpoints are given. `lf credential add` of the OAuth credential then says how to set the app up.
- Two connections of one module under `lf` (`a = connect attio using AttioA`, `b = connect attio using AttioB`) no longer share inbound events. Before, a delivery to either connection's door ran both connections' listens, and `lf serve` registered one webhook, as the first credential, for every connection's events. Now a delivery to a connection's door runs only the listens whose construction names that credential (or names none), `lf serve` registers a webhook per connection, as that connection, for its own listens' events, and a polled listen polls as its own connection. A delivery to the module's install (one door serving every connection) still reaches every listen. With two webhooks, `lf serve` names each as `<module> as <credential>:` in its lines.

## [0.12.8] - 2026-10-26

A patch release of the 0.12 line: it reads the same pins as 0.12.0 (every `0.12.x`) and breaks no program an author wrote.

- A polled listen with `events` runs again under `lf`: a polled source now labels each event with its kind (`eventType`, adapter protocol 2.3), and `lf` narrows by it as it does a pushed event. The bundled Gmail, Evertrace, Dealroom and Granola modules label theirs. An event from an older module with no label still reaches the listen that polled it, and `lf` prints once per module: `<module>: a polled event carries no eventType; …`. Before, every such event was dropped silently.
- A poll now names its listener by the listen's pipeline, `listen:<file>:<movement>` (`movementId`), so a source can tell a listener from a same-named movement in another file.
- `LF_SECRET__<ENTRY>__MODULE=<module>` makes an entry from the environment that module's install, as `module:` does in the secrets file: a separately run adapter's key can come from the environment alone, and its connection needs no `using`. `LF_SECRET__<ENTRY>__EXTERNAL` is unchanged.

## [0.12.7] - 2026-10-26

A patch release of the 0.12 line: it reads the same pins as 0.12.0 (every `0.12.x`) and breaks no program an author wrote.

- A module served under `lf` keeps its run's per-run caches, as it does in process: each call is answered inside the run scope the run names, so a module's read memo and call ceiling work under `lf` (the Affinity module's saving under `lf` is the larger one; see `@listen-fire/affinity`'s own `CHANGELOG.md` for the call counts). `serve-module` says on stderr, once at start, when the process holds more than one copy of the run scope, since a module on a different copy than the kit's would silently have no run cache.
- A hop whose WHERE pins a list reads that list's own columns under `lf`: `` org-[le:`List Entries` WHERE le.`listName` == "Master Deals List"]-> { return le.`Deal Created` } `` checks and runs, where `lf` refused `Deal Created` (it read only what every list has). The member a literal picks is the one the module's write already names for that value, so no module changes. The list's columns read in the body and in the WHERE's other conjuncts, in either order, and an entry of another list is dropped before any of its fields is read. A literal no list has stays the `listName` enum's refusal; a hop with no literal, or a host's own narrowing (the hosted platform's), works as before.

## [0.12.6] - 2026-10-25

A patch release of the 0.12 line: it reads the same pins as 0.12.0 (every `0.12.x`) and breaks no program an author wrote. It is the last release in which every package moves together. From now on modules release on their own versions: a module's contract with `lf` is the adapter protocol minor its manifest states, and its imports of the core are wide peers (`>=0.12.0 <1.0.0`). `lf --version` lists the modules bundled beside it. **For slot module authors:** lf now reads a slot module's manifest before anything else it asks, so a slot module must answer `manifest` first (one served by the module kit or by `lf`'s own slot server already does).

- **Adapter protocol 2.N.** A module's manifest states the minor of adapter protocol 2 it uses, `protocolMinor`, beside `protocolVersion: 2`. The module kits (TypeScript and Rust) and the slot servers compute it from the methods the manifest lists: 2.1 is a `<slot>.watch` method, 2.2 is `work.enqueueIfAbsent`; an author may raise it, never lower it. `lf` and the engine speak 2.0 to 2.2 and refuse a module outside that range by name, naming its package and version when found, what it speaks and what to upgrade; a core module's manifest is now read and checked too, before any other method it is asked: as `lf drain` (and `lf serve --doors-only`) opens for the modules it starts up front, before any work is claimed, and at the first call otherwise. A module stating no minor (every one published up to 0.12.5) is read as 2.0 and loads as before, and an `lf` up to 0.12.5 ignores the field. The refusals of a movements module without `movements.watch` and of a store module without `work.enqueueIfAbsent` now name the minor that added the method. See the protocol's [Versioning](docs/contracts/adapter-protocol.md#versioning).

- `lf --version` prints `lf <version>`, then the adapter protocol range it speaks (`adapter protocol 2.0–2.2`), then the modules bundled beside it with their versions (the bundle's `VERSIONS` file). Modules release on versions of their own, so the binary's version no longer says what the bundle carries.

## [0.12.5] - 2026-10-25

A patch release of the 0.12 line: it reads the same pins as 0.12.0 (every `0.12.x`) and breaks no program an author wrote. Operators: `lf drain` starts every module, the core modules included, as it opens and keeps them up; `lf serve --doors-only` starts only what its doors call; webhook registrations follow movement edits without a restart; a module no movement imports any more stops; a refresh is faster. **Breaking for store module authors:** every store module must answer `work.enqueueIfAbsent` (one conditional insert); arming a polled listen fails naming the method otherwise. The platform's store implements it in its matching release.

- Several `lf drain` workers started at once (a job fleet from zero) poll a polled listen once: arming its standing work row is now one conditional write, so a worker's arm never moves the due time of the row another worker holds, which made that listen be polled again at once. **For store module authors:** the store slot has a new method, `work.enqueueIfAbsent` (insert when no row has the key, else leave the row as it is; answers whether it queued), which lf's SQLite and Postgres stores and the module kit's `Store` trait implement and the store contract cases check. A store module that does not answer it fails a polled listen's arm by name.
- `lf drain` starts the slot modules `lf.yaml`'s `core:` fills with a process of its own (models, ocr, limiter, wake, files, loop guard, judge) as it opens, together with the movements' modules, and keeps them up until it exits; `lf serve --doors-only` starts only the ones a door calls (the limiter and the wake), never models or ocr. A limiter module now opens on its first call rather than before anything else starts. With three such modules beside three adapters: a fresh drain's first run went from 2.5 s to 1.5 s, and doors-only no longer starts the wake module inside the first delivery.
- A refresh under `lf serve` or `lf drain` reads again only the files whose text changed: each file's parse and listens are kept while its text is, and only the check runs over the whole set (imports link across files). A run starts from a copy of its file's parse, kept for the process (the engine's `keep_parses`, 128 files), rather than parsing it again. On a 200-file set, a refresh after one file changed went from 450 ms to 245 ms (the rest is the whole-set check), and a run's parse from 0.35 ms to a 0.08 ms copy.
- An edit under a running `lf serve` or `lf drain` that leaves a module imported by no movement now stops that module's process, once the runs that began before the edit are done with it (`movements: dropped <external>, which no file imports now`). A module a set that does not check started is stopped with it. Before, a refresh only ever started modules. A first-party module, which shares one process with the others, is left out of that process's next start instead.
- A module's webhook registration follows an edit under a running `lf serve`: when a refresh changes the events a module's listens name, lf registers the webhook for them (changed in place where the module can), and removes it once no listen needs it, as `lf serve`'s start does. Before, the refresh only printed that the registration would change at the next restart. A registration that fails is printed once per message and tried again at the next change.
- `lf drain` starts every module its movements import together as it opens, before it claims any work, and keeps them up until it exits: a run no longer waits on a module's start, and the idle stop (`moduleIdleTimeout`) no longer stops a module mid-drain. Every command's open starts the modules together rather than one after another (three modules that each take a second to start: the first run of a fresh `lf drain` went from 3.4 s to 2.0 s).

## [0.12.4] - 2026-10-25

A patch release of the 0.12 line: it reads the same pins as 0.12.0 (every `0.12.x`) and breaks no program an author wrote. Operators: it updates two dependencies past security advisories. Rust embedders: it makes one trait method required, below.

- **Security.** `body-parser` (1.x) is pinned to 1.20.9 or later and `zod` (4.x) to 4.6.7 or later, past their October advisories. Under zod 4.6 an object field typed "any value" (`z.unknown()`) no longer accepts an absent key, so the wire contracts that carry such fields (the protocol, events, expressions, recordings, the run store) now mark them optional, as they always behaved. Nothing on the wire changes.
- **For embedders, a breaking change to the Rust embedding API (an API change, not a language change; within 0.12).** `embed::Store` now requires `save_source` and `load_source`, which keep a library's text under its hash and read it back. Before, they had a default that refused, so an embedder whose run linked a library and then parked failed at park time with "park.sources.save not served". A `Store` that omits them no longer compiles (error E0046 names the missing method); implement both over the same place the store keeps its parks. The TypeScript `RunHostStore` already required its `sources`.
- The story analysis carries an extraction field's type as data: an optional `fieldType` beside `type` on each `StoryExtractNode` field (the catalog's own spelling of the type; a borrowed field path resolved to its declared type; null where nothing resolved). Additive, the analysis stays at version 1.
- The engine's timezone conversion test skips its zone cases when the running Node's tzdata is older than the fixture's (recorded under tzdata 2026e); the other cases still run. A test-only change.

## [0.12.3] - 2026-10-23

A patch release of the 0.12 line: it reads the same pins as 0.12.0 (every `0.12.x`) and breaks no program an author wrote. Operators: the first change below fixes a write that could reach the wrong workspace.

- A record a library movement returns keeps the system it was read from, and a write on it in the caller (a linked write under it, or an update of it) goes through the connection the library read it with, whatever either file calls its connection, including when the library uses a different credential. Before, such a write failed ("a linked write's parent — the system 'ch' came from can't be determined"); and when the caller reused the library's connection name with another credential, the write went through the caller's connection, to the wrong workspace. A park carries the connection's identity (optional: parks written by earlier releases resume as before).
- Upgrading a movement that imports a library no longer applies the library's fixes to it: a diagnostic surfaced at the import line carries no fix, since its edits were in the library's text and corrupted the importer. The library's own check still offers them.
- The extraction keyword's upgrade rewrite keeps a type name's backticks (`<`Pass Reason`>` stays so), where it wrote `<Pass Reason>`, which does not parse.

## [0.12.2] - 2026-10-23

A patch release of the 0.12 line: it reads the same pins as 0.12.0 (every `0.12.x`) and breaks no program an author wrote. Two operator-facing changes need an action, both below.

- `lf serve` and `lf drain` (without `--until-idle`) see a changed, added or removed movement within about a second, from the movements slot's change events instead of a 5 s timer. The folder module uses the OS file watcher. `LF_MOVEMENTS_REFRESH_MS` is now only the pause after a module that answers at once with no events (at least 100 ms). `lf drain --until-idle` no longer refreshes, and one-shot commands are unchanged.
- **Module authors:** every movements module must answer `movements.watch` (`{ cursor?, waitMs }` to `{ cursor, events }` or `{ resync: true }`, held up to 30 s, answering early when its platform's request timeout is shorter). `lf serve` and `lf drain` refuse a module whose manifest lacks it, by name. New conformance cases, `movementsWatchRemovalCase` and `movementsWatchCapCase` in `module-wire`; the generic shape is in the adapter protocol's "Watching for changes".
- `@lf/attio` accepts a static access token as a second credential, `attio_token` (fields `accessToken` and an optional `baseUrl`), beside the OAuth sign-in `attio`. A connection uses one; `lf credential add --module attio <name>` now needs `--credential attio` or `--credential attio_token`. See `modules/attio/README.md`.
- The adapter protocol names one watch shape for every slot, `<slot>.watch` (`{ cursor?, waitMs }` to `{ cursor, events }` or `{ resync: true }`), `movements.watch` being the first slot to use it ("Watching for changes" in the adapter protocol).

## [0.12.1] - 2026-10-23

A patch release of the 0.12 line: it reads the same pins as 0.12.0 (every `0.12.x`) and breaks nothing an author or operator wrote.

- New module `@listen-fire/wake-cloud-tasks` fills the wake slot on Google Cloud Tasks: each wake becomes a task, one per coalescing window, that starts a Cloud Run drain job, so the scheduled drain can drop to an hourly safety net. The `lf` image carries it as `wake_cloud_tasks` (off by default); its fake Cloud Tasks ships in the package for hosts' tests. See `modules/wake-cloud-tasks/README.md`.
- A model vendor that reports its budget spent on a success now closes the key before its 429: `@lf/anthropic` and `lf`'s Anthropic client throttle the API key until the reset named in `anthropic-ratelimit-*-remaining`/`-reset` (a count above zero changes nothing). Modules can use `vendorBudget` and `budgetAfter` from `@listen-fire/engine/public/limiter` (it also reads OpenAI's `x-ratelimit-*` headers). See `docs/contracts/limiter-slot.md`.
- The adapter protocol's "Build your first adapter" walkthrough drives `lf` and `examples/lf-acme` (`lf check`, `lf catalog`, `lf run --webhook`, `lf serve`) instead of the platform's conformance CLI and dev loop.
- The lowering vocabulary (the built-ins' option keys and summaries, the AI tiers, the stdlib families) is generated from one file, `crates/movement-parser/src/lowering/vocabulary/vocabulary.json`, with `cargo run -p listen-fire-parser --features generate --bin gen-vocabulary`; tests hold the checker's standard library and the built-ins reference to it. What a program reads is unchanged.
- `lf serve` and `lf drain` pick up changed, added and removed movement files from the movements module or folder without a restart, checking the new set first. A set that does not check keeps the running one, with the diagnostics printed once. `LF_MOVEMENTS_REFRESH_MS` sets the interval (default 5000). One-shot commands and the wire are unchanged.
- **Embedders:** the movement artifact exports `language_query` (completion, hover, go-to-definition and code actions from the Rust language service) and `story_analysis` (what the check settled, as data: [story-analysis](docs/contracts/story-analysis.md), `Version: 1`), and `@listen-fire/movement-lang` binds them as `completionsAt`, `hoverAt`, `definitionAt`, `quickFixesIn` and `storyAnalysisInRust`. `movement.wasm` grows from 4,065,943 to 4,291,883 B (gzipped 1,271,683 to 1,342,191 B); `movement_parser.wasm` is unchanged. `listen-fire-engine` now depends on `listen-fire-language`, which is published first.
- **Embedders:** the story analysis's effects now say what the program reads: a walk inside `exists(…)` (a hop `WHERE` included) reads its start and landings, `File.read` reads `files`, and `Date.today(zone)` sets `now`, as the earlier TypeScript rule did. `storyAnalysisVersion` stays 1; only the rows' contents change ([story-analysis](docs/contracts/story-analysis.md)).
- **Platform:** presentation surfaces (the editor's completion and hover, the story view) can read the Rust service and analysis for every current pin, and drop the TypeScript dialect they keep for it.
- Publishing (maintainers): the engine crate now depends on `listen-fire-language`, so the crates publish in the order parser, checker, language, engine, module-wire, listen-fire, module-kit (`RELEASING.md`). `@listen-fire/wake-cloud-tasks` is a new package at this release.

## [0.12.0] - 2026-10-23

The first full release of the 0.12 line, and the first of this repository as the language alone: the hosted platform lives in `lf-platform` (same GitHub organisation), which installs the language from the crates and `@listen-fire/*` packages released here. The sections beneath, `0.12.0-rc.2` to `0.12.0-rc.10`, are the detail of how it was reached and stay as history; nothing in them is withdrawn.

**Which pins this release reads.** The language is versioned by its release, and a saved movement is pinned to the release it was written against. 0.12.0 reads a pin with its own compatibility key, `0.12`, which is every `0.12.x` including the `0.12.0-rc.N` pre-releases. It no longer reads the integer pins 1 to 5 (the two-word names are gone), nor any `0.x` pin below the 0.12 key (a `0.11.0` pin among them), and refuses each by name with the remedy: validate it under this release and upgrade (`lf upgrade`, which sets `lf.yaml`'s `engine:` to the running release once nothing is left to fix). A pin newer than this release is refused with "upgrade the engine". Upgrading an automation from integer versions 1 to 4 to 5 remains the platform's, which keeps its own frozen parser for those pins. See `docs/contracts/language-versions.md`.

- The language is the Rust parser, checker and engine, served to JavaScript as two committed wasm artifacts (`@listen-fire/movement-lang`), and `lf`, the command line that builds, checks, runs, serves and operates a project of movements.
- The language is the one formerly numbered version 5 (Dancing Wren); its rules and rewrites are in the [Dancing Wren migration guide](docs/language/dancing-wren-migration.md). Breaking for embedders of the wasm artifacts: their entries take no version, and report their own release (`language_version`, `language_standing`).
- Slots: a project's secrets, movements, store, limiter and models are slots a module can fill (`core: { secrets: … }`, `core: { movements: … }`), each with its wire in `docs/contracts/` and conformance cases in `@listen-fire/movement-engine` (`public/module-wire`).
- Doors keep every delivery as a receipt and a provider's repeated delivery is kept out (`lf deliveries`, `lf deliveries replay`); `lf connect` offers to sign in at once for an OAuth module; a limit of `calls: N, per: <window>` is a rolling window in every limiter; a model call made inside a run names its run.
- Node is 22.23.4 or a later 22.x patch (`engines.node`: `>=22.23.4 <23`); the dependency audit is clean at high severity and CI runs it.
- The `@listen-fire/*` packages publish under npm `latest` and the docs of this release publish as the default under `/docs/0.12/`.

## [0.12.0-rc.10] - 2026-10-22

- `lf connect` on a module declaring OAuth now asks "Sign in now?"; scripted use passes `--yes`.
- A model call made inside a run names the run: the models slot's `models.call` request (and the models door's `HostModelRequest`) carries an optional `runId`, which `lf` sends for a call a run makes, so a host's usage rows can attribute the call to its run. A call outside a run sends none; a module that ignores the field is unaffected. See `docs/contracts/models-slot.md`.
- A limit of `calls: N, per: <window>` is a rolling window in every limiter (lf's built-in, the engine's in-process one and `@listen-fire/postgres-limiter`): no stretch of that length ever holds more than N calls. They were token buckets, which let a burst of N and then one call every window/N put nearly 2N in one window, so a module that declared fewer calls than its provider allows to make up for that can declare the real number now. A refusal's `retryAt` is when the oldest calls leave the window. `@listen-fire/postgres-limiter` keeps each call's instant in a `calls` table; opening it drops the old token columns, and each window starts empty after the upgrade. See `docs/contracts/limiter-slot.md`.
- The built-ins reference names `pdf.render`'s and `web.render`'s `name` setting (and gains a `web.render` entry).
- `web.render` (`@lf/web`) takes a `name` setting for its file like `pdf.render` (`web.render(html, { name: "Q3 report" })`; `.pdf` is added when missing). Without one the file is still `movement-artifact.pdf`.
- `lf connect <module>` for a module that signs users in with OAuth and expects one user credential now ends by asking "Sign in now? [Y/n]" and, on yes, runs `lf credential add --module <module>` in the same command (it asks the credential's name; `--no-browser`, `--headless`, `--public` and `--redirect-port` apply). `--yes`, or input that has ended, skips the offer and prints the next-step line as before.
- `lf deliveries replay` tells the project's wake module (`core: { wake: … }`) of the events it queued, as a door does, so a worker starts at once rather than at the next scheduled drain.

- `lf`'s own Anthropic client throttles per API key, as the TypeScript module does: a 429 on one key no longer closes requests made with another, and the in-flight limit counts per key (the limiter sees a hash of the key, never the key).

- Movement files are read through a core slot, `core: { movements: … }`. The default, `@lf/folder-movements`, is the movements folder `lf.yaml` names, read exactly as before, so a project that names none behaves as it did (same files, same order, same messages). A module filling the slot answers the files by their path under the movements folder (`orders/sync.mvt`): `movements.list`, `movements.read` and `movements.write` by version, so a deployment can keep them in a per-tenant store with no folder on disk. The module's own settings (a tenant) come from `LF_SECRET__<MODULE>__<SETTING>` or the secrets file, never from the secrets slot; a project naming one whose settings neither holds is refused as it loads. `lf.yaml` and the externals folder stay local. Store module authors are unaffected.
- `lf upgrade` and `lf init` write movement files through the movements slot, by version. A file changed between `lf upgrade`'s read and its write is reported (`changed since lf read it; nothing written`) and holds the pin, instead of being overwritten. A movements module that keeps the files read-only (`read_only` with a reason) makes both refuse by name, exit 2, writing nothing: `<module> holds the project's movements read-only: <reason>. Change them where they live.`
- The movements slot's wire is written down in `docs/contracts/movements-slot.md`, with its conformance cases: `lf --contract-movements-slot --dir <project>` serves the project's movements module through lf's own client, and `movementsSlotCases` and `movementsReadOnlySlotCases` (movement-engine `public/module-wire`) hold any movements module to them. `MOVEMENTS_METHODS` joins the other slots' method lists in `engine-contracts/slots`.
- Deploying (operators): a cloud deployment fills the movements slot with `core: { movements: <module> }` and feeds the module's own settings, the tenant among them, through `LF_SECRET__<MODULE>__<SETTING>` (`deploy/lf/README.md`).
- The Evertrace, Dealroom and Gmail handbook sections taught the retired `pollIntervalSeconds` spelling in a `listen` line and its prose; they now teach `every: 10m`. A handbook test runs every fenced example in every public module's section through the checker and refuses a retired spelling.

## [0.12.0-rc.9] - 2026-10-22

- Every delivery a door takes is kept as a receipt holding the events it produced (not its body, headers or signature), written in the door's one write; `lf runs show` names the delivery a run came from. `lf deliveries` lists them (`--subscription`, `--since`, `--json`), `lf deliveries show <id>` prints one with its events and runs, and `lf deliveries replay <id>` queues its events again as a delivery of its own, for `lf serve` or `lf drain` to run against the project as it is now. The drain forgets a delivery after `lf.yaml`'s `deliveries: { retainDays: 14 }` days once its runs are settled and its events are no longer queued. `--ephemeral` keeps its receipts only for the session. A project with no `deliveries:` and no delivery id behaves as before; the state file gains a `delivery` table and `run.delivery_id`.
- A provider's repeated delivery is kept out at the door: an external's `lf-external.yaml` `webhook: { deliveryIdHeader: x-github-delivery }` (or a manifest's `inbound.deliveryId: { header }`, a module's `checkInbound` answer `deliveryId`, an `emit` body's `deliveryId`) names the provider's id, and a second delivery under it at the same subscription is answered `duplicate: true` and runs nothing. Without an id nothing changes. An inline delivery that fails now keeps its pull cursor with its receipt, so its events are recovered by replay rather than by the sender's retry.
- Store modules (a change to the store slot, protocol release rc.9): `inbound.keepDelivery` takes a `delivery` receipt and answers `{ kept }` (false: a duplicate, nothing written), and there are four new methods, `inbound.deliveries`, `inbound.delivery`, `inbound.sweepDeliveries` and `inbound.forgetDeliveryId`; `runs.start` and `events.startRun` take `deliveryId?` and `RunRow` answers it. Every store module must take the wider `keepDelivery` in rc.9; `lf` treats a `null` answer as malformed. A Postgres store gains `lf.delivery` and `lf.trigger_run.delivery_id` (migration 7). See `docs/contracts/store-slot.md`.
- Secrets are a core slot (`core: { secrets: … }`). The default, `@lf/file-secrets`, is the secrets file, SOPS and `LF_SECRET__…` exactly as before, so a project that names none behaves as it did. A secrets module holds credentials elsewhere (a vault a fleet of `lf` workers shares): a token one worker refreshes is kept for all, and two workers refresh it once. A secrets module's own settings come from `LF_SECRET__…` or the secrets file only; a project naming one whose settings neither holds is refused as it loads.
- A secrets module can answer `lf connect`, `lf credential add|update|delete` and a webhook's registration with `read_only` and a reason. `lf` refuses by name (`<module> holds its credentials read-only: <reason>. Add it where it lives.`, exit 2, nothing written); a token refresh is still written back. `lf credential update` now changes the entry in one write instead of a write-back followed by a second write.
- `lf.yaml`'s `oauth: { redirectUri: <url> }` is the redirect URI `lf credential add --public` sends the provider (at authorize and at the token exchange) instead of `<publicUrl>/oauth/callback`, for a relay that holds the registered callback and forwards `code` and `state` to `lf serve`'s `GET /oauth/callback`. `lf connect` prints it among the URIs to register. Unset, nothing changes.
- `lf credential add` and `update` ask a secrets module whether entries can be changed (`secrets.assertWritable`, answering `null` or `read_only` with a reason) before the provider's sign-in, so a read-only module refuses by name before the person is sent anywhere. A module that answered `null` to it (the old test modules) is unaffected.
- The secrets slot's wire is written down in `docs/contracts/secrets-slot.md`, with its conformance cases: `lf --contract-secrets-slot --dir <project>` serves the project's secrets module through lf's own client, and `secretsSlotCases`, `secretsReadOnlySlotCases` and `SecretsSlotBackend` (movement-engine `public/module-wire`) hold any secrets module to them and to the family's eleven cases. `SECRETS_METHODS` joins the other slots' method lists in `engine-contracts/slots`.
- Deploying (operators): a cloud deployment fills the secrets slot with `core: { secrets: <module> }` and feeds the module's own settings through `LF_SECRET__<MODULE>__<SETTING>`, as for the other slot modules (`deploy/lf/README.md`).
- `@lf/anthropic`: a 429 reaches the throttle at once. The keyed provider's SDK client no longer retries a 429 itself (it slept on Retry-After, twice, inside the held permit); the client's own backoff still retries 5xx and network failures. The throttle and the concurrency ceiling of 8 are now per API key (the caller carries a hash of the key, never the key), so a 429 on one key no longer closes calls made under another.
- The engine's zone database moved to tz 2026e (jiff-tzdb 0.1.9), the data Node 22.23 carries. A run across the zones whose rules changed (Africa/Casablanca, Africa/El_Aaiun, America/Inuvik, America/Tijuana, Europe/Chisinau, EST5EDT) may convert differently. The wasm artifacts are rebuilt.
- Node is pinned to 22.23.4 (the eMudhra CA fix) and `engines.node` is a range, `>=22.23.4 <23`, so a later patch keeps the optional modules installed. The dependency audit is clean at high severity, and CI runs `pnpm audit --prod --audit-level high` as its own job.
- The light build (`lf` without `serve`, `--no-default-features --features cli`) builds again, and CI builds it.
- Debug and test builds carry line tables only (`[profile.dev]` and `[profile.test]` in the workspace `Cargo.toml`), so a build directory holds smaller test binaries. The release profile, and so the wasm, is unchanged.

## [0.12.0-rc.8] - 2026-10-22

- `lf connect` of a module package that serves plugins (`@lf/pdf`) installs it as a plugin external (`kind: plugin`), so `lf check` passes without a hand edit.
- `lf resume` with no run steps only what is due: a timer that has come, an await that can resolve now. It no longer runs out every sleep at once, which fired the timeout arm of a run waiting on an approval; `lf resume <run-id>` still runs one run out now, and a resume with nothing due says how many runs wait.
- Under `lf serve`, opening a callback's `url` in a browser (a GET) renders the hosted door's confirm page, a field per parameter, instead of a 404; its form post calls the callback and is answered with a page. A GET never calls it.
- `--dry-run` rehearses the whole run. A rehearsal that parked (on a callback, say) resumed as a real run and made its later writes for real; it now captures them, and `lf call` and `lf resume` print them as not written. `refresh` of a record the rehearsal created moves nothing, instead of failing with "no longer exists" on a module that reads records by id (an engine change: the wasm artifacts need rebuilding).
- `lf call` (and the callback door's log under `lf serve`) reports a call as one line for its run, its writes the body's and the continuation's together, instead of a `called` line and a `run` line with different counts.
- `pdf.render` (`@lf/pdf`) takes a `name` setting for its file (`pdf.render(text, { name: "Q3 report" })`; `.pdf` is added when missing). Without one the file is still `movement-artifact.pdf`.
- `lf run <movement> --text "…"` gives the manual Invocation its `Text`, as "Run now" with pasted text does on the platform.
- A manual run started with no text (`lf run <movement>` without `--text`) reads `run.Text` as `""`, as `Content` already did, instead of absent while typed as text; `run.Text == ""` is the test for no text.
- **Breaking (lf):** email under `lf` matches the handbook. `inbox = connect email` needs no credential: a module whose declared credentials are all optional constructs without `using` (the credential-free schema; sending refuses by name until `connect email using <keys>`). An email listen takes `key` (`listen to inbox { key: "deals" }`), and `lf` routes each message to the listen whose `key` is the plus-suffix of the address it was sent to (`<box>+deals@…`, compared without case); a listen with no key hears mail sent to the box itself, and a suffix no listen has runs nothing (a logged line), where before every email listen ran on every message. A catalog rule change: the wasm artifacts are rebuilt.
- A vendor's rate limit (a 429 with its `Retry-After`) now closes the caller's key in the limiter slot until that wait is over, so every request made as that caller waits it out, in every host sharing the limiter, instead of the one request sleeping while it holds its place. `@lf/anthropic` (TypeScript and `lf`'s own client) throttles for the `Retry-After`, else `rateLimitWaitMs`; `@lf/affinity` declares four requests in flight per credential and throttles a 429 for its `Retry-After`, else 30s; `@lf/web`'s Bright Data zones are limited (SERP 14 a minute, Web Unlocker ten in flight) and a 429 throttles the zone. `vendorWaitMs` and `throttleAfter` are public in `@listen-fire/engine/public/limiter`, and the limiter contract cases in `public/testing`.
- `@lf/postgres-limiter` publishes its `typesVersions` like its sibling packages, so a consumer resolves its types from the published package.

## [0.12.0-rc.7] - 2026-10-22

The language is versioned by its release. The integer language versions and their two-word names
are gone: a saved movement's pin is the version of the release it was written against (`0.12.0`),
and a release reads every pin with its compatibility key (the minor under 0.x, the major from 1.0),
refusing a newer pin or an older key by name with the remedy. Breaking for embedders of the wasm
artifacts: their entries take no version any more (below). The docs of a 0.12 release live under
`/docs/0.12/` (a pre-release's under `/docs/next/`), and the `/docs/v5/` links already released
redirect there. `lf.yaml`'s `engine:` is the project's pin, and `lf upgrade` sets it to the
running release once nothing is left to fix.

- Breaking for embedders of the wasm artifacts (0.12 pre-release line): no entry takes a language version any more. An artifact reads its own release's language, and the host applies the compatibility rule before calling. The parse and spelling entries lose their `version` argument; `check_program` and `check_answer` take an options JSON (`{"upgradingFrom": "0.11.0" | null}`) in place of the two integers; the engine's segment input carries `languageVersion` as a version string; and two new entries, `language_version` and `language_standing`, name the artifact's release and how a pin stands against it. Movement source is unchanged. movement.wasm 4,077,914 → 4,066,321 bytes; movement_parser.wasm 1,308,180 → 1,300,654.

## [0.12.0-rc.6] - 2026-10-22

- The hosted platform (the api, the web app, the dev loop and the deploy images) now lives in its own repository, `lf-platform`; this repository is the language.
- The published `@listen-fire/movement-lang` carries wasm artifacts built from this version (rc.5's were built before its version bump; functionally identical, only the build metadata differs).
- `@listen-fire/fake-channels` exports its `bin` subpath, so `./bin/fake-channels.cjs` resolves (rc.5's `exports` map hid it).

## [0.12.0-rc.5] - 2026-10-21

This pre-release is the last one built from the combined repository. The language now serves
version 5 only, and a pin below 5 is refused by name (upgrading automations from versions 1-4 is the
platform's). The next release splits into `listen-fire` (the language) and `lf-platform` (the hosted
product), which installs the language from these packages.

- The fake third-party services (Slack, Attio, Affinity, email, WhatsApp, the OAuth provider and the rest) are the package `@listen-fire/fake-channels`, with a `fake-channels` command (port from `FAKE_CHANNELS_PORT`). The dev loop, the demo `fake-channels` image, lf's test harness and the examples all start it from there; nothing changes for the demo's image name or port.
- Set `GEMINI_API_KEY` to call Gemini through the Gemini Developer API instead of the project's Vertex endpoint (which was returning 429s for some projects). The service account then serves only OCR and Claude on Vertex; without the key nothing changes.
- A rate-limited model call now waits as long as the vendor's retry-after asks, instead of a fixed 30 seconds.
- The movement artifact (`movement.wasm`) exports two more Rust checker answers, `check_answer` (the engine's `check.program` request as data: diagnostics, stamps, import link) and `check_compatible` (an `IS <Decl>` test of a system's record), so the JavaScript host answers both without the TypeScript checker. The artifact grows by about 4.5 KB gzipped; the parser artifact is unchanged.
- The language serves version 5 (Dancing Wren) only: the Rust parser, checker and engine, and the committed wasm artifacts, refuse a pin below 5 by name ("this automation is written in language version "Luminous Owl" (4), which this release does not support …"). Upgrading an automation from versions 1–4 to 5 is the platform's (`upgradeAutomation`), and the platform keeps reading and running those pins with its own frozen parser and the TypeScript engine; `lf upgrade` rewrites version 5 files only. Both artifacts shrink (movement.wasm 1,288,555 → 1,272,392 bytes gzipped; movement_parser.wasm 366,623 → 363,328).
- Identity matching treats blank text as no key at every language version. A run pinned to version 1 (Quiet Heron) used to match an empty identity field against another empty one; it now decides as version 5 does, so a blank never matches and never selects a record on its own.

## [0.12.0-rc.4] - 2026-10-20 (pre-release)

A third pre-release of the 0.12 line, published the same way as rc.2 and rc.3.

### hover

- The platform's WhatsApp number door saves each message durably before acknowledging Meta, so a restart, deploy or frozen instance no longer loses it; Meta's resends never dispatch twice. The WhatsApp module's events now carry the message id as their idempotency key, so lf also runs a resent message once.

- lf reads a PDF's text layer in a short-lived child process (30 s, 64 MiB input, a 2 GiB memory limit on Linux), so a malformed or hostile PDF can crash only that child, never `lf serve`. Such a file is reported unreadable; it is not sent to paid OCR.

- **A new core slot, `ocr`**, empty by default. With it filled, lf reads a born-digital PDF's own text and sends scans and images to the slot, so `extract()` reads screenshot decks with no change to the movement. `@listen-fire/document-ai` fills it with Google Document AI; the models module's `models_ocr` entry fills it with Gemini. Plugins reach it through `ctx.ocr` (the dealflow URL plugin now reads screenshot PDFs). Each read counts against the run's cost cap. Both modules, and `@listen-fire/models`, ship in the lf release bundle and the lf image.

- **`@listen-fire/models` fills lf's models slot with Gemini, OpenAI, Anthropic or Vertex**, mapping movement model names as the platform does (`model_map` setting). Models modules may publish their prices (`models.prices`). lf refuses a call the run cannot afford before making it, and under a cost cap that refusal pauses the run (`lf resume` carries on) instead of failing it. lf refuses an answer that used tokens but reports no cost. `judge-llm` runs as lf's judge on any vendor, through lf's models door.

- The Slack app's events and button doors now save each delivery before acknowledging it. The work runs from the queue, so a restart or a frozen instance no longer loses it, and a Slack retry never dispatches twice.

- Hover in `.mvt` files leads with what the adapter or plugin says about itself, then the record's fields and where a walk can go next. Comments get no tooltips, and plugin package names get one. Adapters, record types, fields, edges and plugins may send an optional `description`, which the catalog snapshot carries (still contract version 1). The built-ins reference now lives with the language (`crates/movement-language/src/builtins.md`); the handbook reads it from there.
- A Zed extension for movement files (`editors/zed`), launching `lf lsp`.

## [0.12.0-rc.3] - 2026-10-20 (pre-release)

A second pre-release of the 0.12 line, published the same way as rc.2: images at this tag only, npm under `next`, a pre-release GitHub release, docs under `/docs/next/`.

### rc3-build

- **lf in the cloud.** `lf serve --doors-only` (`LF_DOORS_ONLY=1`) is for compute billed by the request. It runs no drain. `/hooks` and callback links queue their work and answer 202, listing what they queued; a drain (`lf drain`) runs it. An unrecognised `LF_DOORS_ONLY` value is refused.
- **A new `wake` core slot**, empty by default. After queuing work, and only once the write has committed, lf tells it "ready now" or "ready at T", so whatever starts lf's workers (such as a cloud task queue) can start one then. A failed wake is logged and the work stays queued. Its wire and conformance cases are in `docs/contracts/wake-slot.md` and `lf --contract-wake-slot`. A core module reached only at its `url` now passes the manifest check.
- **`@listen-fire/s3-files` (`@lf/s3-files`)** fills the files slot with an S3-interface bucket (AWS S3, Google Cloud Storage, Cloudflare R2, MinIO). Its credentials live in lf's secrets.
- **`@listen-fire/postgres-limiter`** fills the limiter slot from Postgres, so many lf workers share one count. Permits expire on the server, and its tables live in their own schema.
- **The lf cloud image carries both slot modules** (`s3-files`, `postgres-limiter`) with ready install entries, so a deployment needs nothing from npm. Neither is a default. The image build also works again: it now copies the Rust module example and reads its own ignore file, since the repository one leaves out `crates`.
- **Rate limits can count a module's own provider requests, retries included.** A module that declares `hostLimits: true` (never inferred from `limits`) asks lf's limits door before each request: through `ctx.fetch` in the TypeScript kit, or `ctx.permit()` in the Rust kit. lf then stops counting the call itself. This is an additive change within adapter protocol 2. Declare `hostLimits` only if every provider request goes through the kit; otherwise lf counts each call once, as before.
- **lf: a crash no longer leaves run state half written.**
  - A park, an event's receipt with its run, and an inbound delivery's cursor with its queued work are each written in one transaction. The store contract gains `parks.commit`, `events.startRun` and `inbound.keepDelivery`.
  - A run whose worker died is failed with "worker lost: lease lapsed". Drains check for these every 30 seconds.
  - A failing queue row backs off from 30 seconds to an hour, then gives up after 10 attempts and fails its runs (Postgres migration 5).
- **The legacy pipelines are gone.**
  - Dropped: pipeline configurations, inputs, outputs and message types, the dealflow pipeline, and the output-run tables, with the columns that pointed at them.
  - Also removed: the pipeline-runs usage limit and the per-pipeline LLM usage view.
  - Saving a movement no longer needs a pipeline configuration. A deploy applies the drop.
- **lf: a movement's return value is its run's output**, as a cron job's is. Every run records it in its history, capped at 64 KiB of JSON; a returned file is kept as a reference. `lf run`, `lf resume` and `lf call` print it, and `lf runs show` and the `--json` documents carry `returned`. Runs that events start send it nowhere, and no door ever answers with it. `@lf/postgres-store` adds migration 6: run `lf connect @lf/postgres-store` to migrate.
- **Breaking (lf): lf refuses to read a `secrets.yaml` that group or other users can read**, the way ssh refuses an open private key. This applies to the project file, `~/.config/lf/secrets.yaml` and `LF_SECRETS_FILE`; Unix only. The error names the file; fix it with `chmod 600 <path>`. Files lf writes are always 0600, and the `LF_SECRET__*` env vars are unaffected.
- **Breaking (lf): `{lf}` in a module's `lf-external.yaml` env now means the module's own folder**, `.lf/externals/<name>/`, not the project's `.lf`. A manifest that wrote `{lf}/externals/<name>/x` should now write `{lf}/x`.
- **The deploy check no longer moves a saved automation onto a newer language version.** It reports the automations that validate clean under the newer version as ready to upgrade. Only an explicit upgrade moves the pin: `lf upgrade`, or `upgradeAutomation` over MCP.
- **Extraction graphs, extraction plugins and the `/enrichment` page are removed**, along with the admin trigger-events page. Movements are now the only automation into the knowledge graph. A deploy drops their tables.
- **Removed: the in-platform agent** (the assistant panel, the model onboarding chat, `/v1/system/conversations`, `pnpm dev:chat`). Use your own agent over the MCP connectors; every MCP tool is unchanged. Conversation history tables are kept, read-only.
- A GET to a webhook door answers 404, as before, unless its provider checks its own inbound (Meta's handshake).
- The lf crate ships its own copy of the model price table, so `cargo publish` works. The published crate set now includes `listen-fire-module-wire` and `listen-fire-module-kit`. The Chromium image ships Noto fonts.

### merge-3

- `ctx.kv.compareAndSet` is atomic everywhere: on the platform an ask or a grant is written by one conditional statement, and the file kv (`MODULE_STATE_DIR`) writes under a lock file, so processes sharing the directory never lose a write.
- A models module's `models.call` answer carries `usage` (the tokens it spent), required; lf reports it as the call's usage and refuses an answer without it, and the module's `cost` counts against `maxRunCostUsd`. lf's own models module served over the wire honours `maxTokens`.
- The store contract gains `processes.list` and `processes.swap`: the module processes lf started, written by compare-and-set on the list's version, so two lfs on one store never overwrite each other's entries (SQLite, Postgres migration 4, the HTTP store wire, the Rust kit's Store trait). Postgres migration 3 stays retired.
- The platform's webhook door knows whether a remote install checks its own inbound from the install's stored manifest, so an unsigned delivery to a host-verified install is refused without resolving the module.

### kit-contracts

- `@listen-fire/module-kit` no longer depends on `@listen-fire/engine`. What a module is written against now lives below the engine: the runtime-neutral contract in `@listen-fire/engine-contracts` (the adapter contract and its manifest, the catalog's schema types and positions, the Expression vocabulary, plugins as data, model names, the team header), and what a Node host shares with its modules in the new `@listen-fire/module-runtime` (a live adapter's file bytes as a stream, the secrets family with OAuth 2 refresh and connect, the in-memory vault, the browser slot, the queue). The engine's public entries re-export both, so existing imports keep working; module tags and type ids are unchanged.

### i-procs

- lf starts a module's process only when a run or check needs one (only the externals the movements import), keeps it up while used, and stops it after `moduleIdleTimeout` seconds unused (lf.yaml, default 300). A crashed module starts again on its next call; one call may take `callTimeout` seconds (default 600). First-party `@lf/*` modules and any marked `trusted: true` in their `lf-external.yaml` share one Node process (`serve-module` now serves several modules, each under its own path, with `MODULE_MOUNTS`); every other module gets its own. Module processes exit with lf, and ones a killed lf left behind are stopped on the next start (tracked in the store). `runtime: node 22` in `lf-external.yaml` is checked before a module starts (a served module defaults to node 22). A local module runs with your permissions: there is no sandbox yet.
- `lf lsp` reads the catalog again when a file is saved, and when a module process lf started ends on its own (a crash, or a module reloading itself): the read starts it again, so the editor sees the restarted module without restarting the language server.

### i-rustkit

- **Modules in Rust: `listen-fire-module-kit`** (`crates/module-kit`). A trait per module kind (`Adapter`, `Plugins`, and the core slots `Store`, `Limiter`, `LoopGuard`) and a `Host` that serves one or several of them over adapter protocol 2 HTTP, each at `/<name>`, on loopback TCP (`PORT`, prints `listening <port>`) or a Unix socket (`--socket`/`LF_MODULE_SOCKET`). A host is its own process; lf reaches it as any module server (`url:` in `lf-external.yaml`). Example: `examples/rust-module`.
- The protocol's envelope, JSON in JavaScript key order and every result's schema check move from lf into `listen-fire-module-wire` (`crates/module-wire`), which lf and the kit share. No behaviour change in lf.
- A Rust module host that lf starts by `command:` exits with lf, as serve-module does (`LF_EXIT_WITH_PARENT`: its stdin closing, or being re-parented to init).

### i-wire
- One transport for every module kind: every core slot (store, models, judge, files, limiter, loopGuard, browser) speaks adapter protocol 2's HTTP — a Unix socket on the same box, loopback TCP without one, HTTPS for a remote module (`url:` in lf-external.yaml) with per-install outgoing auth (a Google identity token from the metadata server, or a static bearer). The store, limiter and loop guard stdin/stdout JSON-RPC wire is retired; `lf --contract-<slot>` servers speak the wire on `--listen`. New slot methods for models (no streaming), judge, files and browser (docs/contracts/*-slot.md, shapes in `engine-contracts/slots`), with conformance suites (`movement-engine/public/module-wire`) run against lf's built-ins.
- `ctx.kv.compareAndSet(key, expected, value)`: write only if unchanged (memory, file and the platform's kvs). serve-module listens on `MODULE_SOCKET` and prints `listening unix:<path>`.
- A core slot's module that lf starts (store, models, judge, files, limiter, loopGuard) is started as every other module process is: on its first call, stopped when idle, started again after a crash, on a Unix socket that stays the same across restarts. A browser module is started with the session and held, since the modules lf hands it to call it directly. serve-module's shared host listens on `MODULE_SOCKET` too, each module at `http+unix://<socket>/<path>/`.
- The Node module-wire client, server and starter live in `@listen-fire/module-runtime/module-wire` (movement-engine's `public/module-wire` re-exports them), so the module kit reaches the browser over the wire without depending on the engine. `lf --contract-<slot>` exits with its parent under `LF_EXIT_WITH_PARENT`, which the Node starter now sets.

### i-inbound

- A module can check its own inbound requests (protocol 2, additive: `inbound.scheme: module` with the `checkInbound` method). The host hands it the raw request and sends its answer: the events, a refusal, or a reply such as a handshake. The platform's webhook door and `lf serve` use it when a module declares it, and the door takes GET for such a module; declared signature schemes are unchanged.
- `lf` can now receive email and WhatsApp. `@lf/email` takes Mailgun and Resend deliveries at `/api/public/webhook-sync/email/<install>`, and `@lf/whatsapp` answers Meta's verification handshake, checks Meta's signature and reads inbound media by Meta's id.

### i-plugins

- **Plugins are keyed by module and name.** Two modules can each serve a plugin of the same name: `@lf/pdf` and `@lf/web` both have a `render`. Movement syntax is unchanged: ``import { `@lf/web` as web } from plugins``, then `web.render(…)`. A bare import of a name that two packages serve (`import { render } from plugins`) is refused, naming both packages and the package import to write instead; a bare name only one package serves works as before, so saved movements on versions 1 to 4 run unchanged. A catalog snapshot's plugin keys are now `@lf/web/fetch_url` for a package's plugin, each spec carrying its `name`; a snapshot with plain names still reads.
- **`@lf/web` has a `render` plugin: text or HTML drawn as a PDF by the host's browser.** `web.render(text, { pageSize, margin })` has the call shape of `pdf.render`. HTML (a document, or markup such as an email body) keeps its layout; plain text is put on a page with its line breaks kept. It prints through the host's browser slot (the page's print to PDF), so any text the browser's fonts cover prints, with no `?` substitution and nothing added to the core image. With the slot empty (`lf`, the slim API image) the call is refused by name, as a gated document is; there is no fallback to `pdf.render`'s writer. Scripts in the HTML do not run.

### au-delete

- The legacy v3 output pipeline is removed (its executor, per-destination adapters, authoring agent and the `knowledge.outputAgent` / `knowledge.expressionWriter` tRPC routes). It had no remaining callers; movements are the only way data moves. A migration sets any stored v3 output (`pipeline_output.config_version = 3`) still marked live or dry-run to `off`; its config is kept.
- The frozen translation-graph evaluator and its parity-era schema tests are removed from the platform and the engine package. Movement results are unchanged.

### au-units

- **`system` is a module, `@lf/system`** (`modules/system`), hosted in process by the platform. Platform-supplied: it reads the platform's own records of runs and events, so it is never published or shipped with lf. Movements, events, fields and timing are unchanged (recorded parity: the whole read surface and the poll replay identically). Switching back is one line (`BUILTIN_MODULES`).
- A module's poll now receives the automation its listen belongs to (`movementId`, optional, protocol 2 minor), so a source about automations can keep an automation from being told about itself.
- **Listen-Fire Valuations is a module, `@lf/native-valuations`** (`modules/native-valuations`), hosted in process by the platform. Platform-supplied: it calls the platform's own Valuations API, so it is never published or shipped with lf. The movement tag (`native-valuations`), credential type, events, fields, writes, commands and the hosted webhook URL are unchanged (recorded parity against a fake Valuations API: the whole surface, the computed `Valuations` edge, writes, commands, inbound and the webhook lifecycle replay identically). A credential that names no base URL still means the platform's own address (`API_BASE_URL`). The credential is now read on every call, so a rotated api-key is seen at once. Switching back is one line (`BUILTIN_MODULES`). The Valuations product itself (its REST routes, schema and the outbox worker that sends the webhooks) stays in the platform.
- Valuations deliveries are now verified by the module's declared inbound (the same `attio`-style HMAC over the same headers). Existing subscriptions keep today's leniency; a subscription created from now on with no usable secret refuses deliveries (every registration mints one).
- `defineModule` accepts a manifest naming the package's bare name as spelled (`native-valuations` for `@lf/native-valuations`) as well as its slug.
- **WhatsApp is a module, `@lf/whatsapp`** (`modules/whatsapp`), hosted in process by the platform. The adapter, the Meta inbound parse and the Meta Cloud API client its sends use moved; the platform hands it its one Meta app (the same `WHATSAPP_*` and `TWILIO_ACCOUNT_SID` env) as the module's credential, and its files. Unchanged: webhook URLs, their verification and verify-token handshake, phone verification (OTP), which phone belongs to which team, the adapter type, trigger kinds, events, fields and every send (recorded parity: the whole surface replays identically on the old line and on the module). Published: lf can serve it with your own Meta access token and phone number id. Switching back is one line (`BUILTIN_MODULES`).
- **`email` is a module, `@lf/email`** (`modules/email`), hosted in process by the platform and published. It holds the adapter, both providers' inbound parse and signature checks (Mailgun's HMAC, Resend's Svix), the Resend message and attachment fetch, and the outbound senders (Resend, Mailgun, the dev loop's outbox). The platform's own mail (magic links, signup confirmation, notices) sends through the module's sender, built from the same environment as before. Unchanged: inbound addresses, the adapter type and its `mailgun`/`resend` aliases, trigger kinds, routing keys, every accept/refuse answer at the doors, and every env var. Routing mail to a team, the dropped-mail and outbound-email ledgers and the doors' routes stay with the platform. Recorded parity: the adapter, the doors and the senders replay identically on the legacy line, the module in process and (adapter) the module served as a process. Switching back is one line (`BUILTIN_MODULES`).
- Hosts other than the platform can run `@lf/email` with a user's own Resend or Mailgun account as its `email` credential (`resendApiKey`, `mailgunApiKey`, `mailgunSendingDomain`, `from`, …); `emailSenderFrom` makes a sender of that credential. The engine no longer exports the mail doors (`movement-engine/public/inbound`); import them from `@listen-fire/email`.

### au-light

- **A light `lf`.** `cargo install listen-fire` is unchanged (the default features are the full `lf`). `cargo install listen-fire --no-default-features --features cli` builds a light one for embedding or a small box: SQLite store, local and `serve-module` modules, `lf check`, `lf run`. It leaves out the Anthropic client (`anthropic`), the OAuth2 sign-in and token refresh (`oauth`), the Postgres store and its TLS (`postgres`), the inbound doors and `lf serve` (`serve`), and with them the whole TLS stack. Each omitted piece refuses by name when a project asks for it ("this lf was built without the `postgres` feature…").
- **`@listen-fire/model-providers` is chat only.** Embeddings, image generation and transcription are now `@listen-fire/embedding-providers`, `@listen-fire/image-providers` and `@listen-fire/transcription-providers` (import `embed` from `@listen-fire/embedding-providers`, and so on). The vendor SDKs stay optional peers.
- **S3 storage and Google OCR are optional packages**: `@listen-fire/files-s3` and `@listen-fire/ocr-google`, `optionalDependencies` of the api, so `pnpm install --no-optional` leaves out the AWS and Google Cloud SDKs. A default install and the same environment behave as before; a build without a package whose variables are set refuses at first use, naming it.
- An embedding host with no file-text module now fails an `extract` over a file naming the file ("this host has no file-text module, so it cannot read the file "deck.pdf"").
- The api no longer depends on `@langchain/*` or `@slack/events-api` (nothing imported them), and the unused `lib/ocr` copy of the OCR code is gone.

### s-logs

- Set `LOG_FORMAT=json` to log one JSON object per line with a Cloud Logging `severity` (`DEBUG`/`INFO`/`WARNING`/`ERROR`/`CRITICAL`), `message`, `timestamp` and `contextId`. The default is unchanged. Boot refuses any other value.
- New optional database pool settings for small Cloud SQL instances: `PRISMA_POOL_MAX`, `KYSELY_POOL_MAX` and `KYSELY_POOL_IDLE_TIMEOUT_MS`. Unset keeps today's pool sizes. Boot refuses a value that is not a whole number in range. See `deploy/SELF_HOSTING.md`.

### s-redis

- Redis is now truly optional. With `MESSAGE_QUEUE_REDIS_HOSTNAME` unset (or, on compose, set empty in `deploy/.env`, which also keeps the bundled Redis from starting), the favicon cache, MCP OAuth in-flight state and the runaway-loop guard's counters live in one small expiring Postgres table (`automations.cache_entry`, added by a migration) instead of nothing or process memory. They are now exact across API instances and survive a stop between requests; the loop guard pays one database round trip per dispatch. With the hostname set, Redis is used exactly as before. Defaults are unchanged: compose still runs the bundled Redis unless you ask otherwise.

### s-enqueue

- **No movement runs inside a request.** Run now (the app, `POST /automations/run`, the trigger Send box), event replay (the app and admin), inbound email, WhatsApp, and a fired callback button or link now store the event, queue a work row and answer; whichever worker drains next runs the movement, as Slack and the webhook doors already did. A deployment whose api stops between requests no longer loses or stalls those runs; one with an always-on worker sees the same runs, a moment later.
- **Run now and replay answer with the run's id at once** and the caller follows it: the app polls the new `movement.runStatus` (admin: `crossTeamOps.replayRunStatus`) until the run settles. A run waits in the queue as `running`; a paused listener or a guard settles it `failed`, naming why.
- **Retrying a request no longer starts a second run.** Run now takes an optional `requestId` (the app sends one per press); a retry with the same id gets the first run back. WhatsApp messages are now deduplicated on their message id, as email already was on its Message-Id.
- **A loop-guard throttle's held event is released from the work queue**, not an in-process timer, so a restart no longer drops the release.
- **A fired callback answers 202** (recorded, the body queued) on the HTTP callback door, where it used to answer 200 after starting the body in the request's process.

### s-image

- The API image is now built in two variants and carries production dependencies only. `ghcr.io/listen-fire/api` is unchanged in features (it keeps Chromium); new `ghcr.io/listen-fire/api-slim` leaves Chromium out for a smaller image and faster cold start. Document fetches behind browser-rendered viewers (DocSend, Papermark, Notion) and PDF rendering fail on the slim image with an error naming the browser variant. Compose runs the browser variant unless `LISTEN_FIRE_API_IMAGE` and `LISTEN_FIRE_API_TARGET` are set (see `deploy/SELF_HOSTING.md`, "Image variants"). The demo's seed and fake CRM services now run the compiled scripts, not ts-node.

### n-browser

- **The browser is a slot the host fills.** A module asks for a page through `ctx.browser`; the platform's api image fills it with Chromium (`@lf/chromium`), and lf, `serve-module` and the api-slim image leave it empty, so a module asking for a page is refused naming the slot. Limits are the slot's: 2 sessions at once, 5 minutes each. Wire and contract suite: [browser-slot.md](docs/contracts/browser-slot.md).
- **The gated-document reader moved into `@lf/web`.** DocSend, Pitch, Canva, Google Slides and Docs, Papermark, BriefLink, Tome, Figma and Notion are read by the module through the browser slot, not by the platform. On the platform nothing changes: same pages, same PDFs, same alerts. Off the platform a gated address fails naming the empty browser slot (it said "the platform's gated-document browser" before); a host that lends a browser gets the document read and kept in its files. A shared Google Drive file is read with the credential's new optional `googleDriveApiKey` off the platform (the platform keeps `GOOGLE_DRIVE_API_KEY`).
- **lf:** `core: { browser: … }` is refused: lf has no browser module.

### au-ask

- **`ask` is a module: `@lf/ask` (`modules/ask`).** Nothing changes for a movement: `asks = ask()`, the eight families, `Url`, `State`, `Cancelled`, and reading, writing or awaiting `Response` behave exactly as before, under the same `ask` type. The module owns what an ask is (the families, the answer each accepts, open → answered or expired, the first answer standing); the host keeps the records in its kv, answers at its own door, and wakes a run parked on an ask when the ask settles.
- **On the platform nothing moves.** The asks table is the module's kv, so asks raised before this release (open, parked on, or settled) answer, cancel and wake exactly as before. The answer link stays `/api/asks/<token>`; the link page, Slack and Telegram buttons, MCP, the control tower and `POST /v1/asks` all answer through the module. Whoever waits on an ask is now told from one place, the table's settle; an ask closed because its run went away also queues a wake, which finds nothing parked and does nothing.
- **A host with no answer door refuses to raise an ask, by name**, rather than minting a link nobody can open. lf does not host `@lf/ask` yet.

### au-engine

- **The engine package no longer carries a model vendor, Google auth or a logging library.** `@listen-fire/engine`'s runtime dependencies are now engine-contracts, movement-lang, shared, zod and safe-stable-stringify. Nothing an operator sets changes, and saved movements run as before.
- **New `@listen-fire/anthropic` (`@lf/anthropic`, the models slot's module for Claude).** The Anthropic client, its web tools and structured output, the chat seam, the keyed provider, the extraction and `AI()` clients, the JSON reply reader (`parseJson`, `parseJsonReply`) and the price table (`prices.json`) moved here from the engine. Embedders: import them from `@listen-fire/anthropic`; the engine's `public/anthropic` and `public/json` entries are gone, and `public/models` no longer carries the clients or prices. The Rust `lf` embeds the same `prices.json` (its own copy is gone), and both clients are tested against the module's shared fixtures.
- **New `@listen-fire/judge-llm` (`@lf/judge-llm`, the judge slot's module).** The LLM identity judge (its rules, prompts and recorded replay) moved here; the engine keeps the slot. The platform fills it as before.
- **Google service-account auth left the engine.** Vertex and Gemini get it from `@listen-fire/model-providers` (`google-auth-library` is now its optional peer); the platform's Gmail adapter owns domain-wide delegation and the mailbox allowlist; Gmail scopes come from `@listen-fire/gmail`. The engine's `public/google-cloud` entry is gone.
- **Engine logging is a hook.** The engine logs through one replaceable hook (`routeEngineLogsTo` in `public/log`) that prints the same text or `LOG_FORMAT=json` lines to stdout by default. The api server keeps winston for request lines and uncaught exceptions, in the same line format.
- **`tsx` is now an optional peer of `@listen-fire/module-kit`.** `serve-module` serving a built module needs none; install `tsx` beside it to serve a module written in TypeScript.

### n-pdf

- **A PDF is the `@lf/pdf` plugin's, not Chromium's.** ``import { `@lf/pdf` as pdf } from plugins``, then `pdf.render(text)` is a file (A4 by default, Helvetica, the text wrapped at the page edge, spaces and line breaks kept). Settings, last: `{ pageSize: "a4" | "letter", margin }` (points). No browser, no dependency, no font to ship, so the core image stays small. A character outside Latin-1 and the Windows-1252 punctuation (CJK, emoji) prints as `?`, and the run is warned, naming `@lf/pdf` and that a Unicode PDF module can replace it. The platform loads the module in process; `lf` serves it with `serve-module` like `@lf/web`.
- **Language versions 1 to 4 keep `FILE(text, "pdf")`**, drawn by the same writer. From version 5 `FILE(…, "pdf")` and `File.from(…, "pdf")` are `MOV_V5_SPELLING`, with `pdf.render(text)` as the rewrite (not marked safe, because the import is yours to add), and `pdf` used without its import offers the import line as a fix. `File.from(…, "text")` is unchanged. Added to the platform's plugin catalog as the second package after `@lf/web`.
- **Plugin answers can carry files and warnings** (adapter protocol 2, additive): `files` (bytes inline as base64, stored by the host and put at `data.<field>`) and `warnings` (each a warning on the run, `MOVENG_PLUGIN_WARNING`). A plugin declaring a `value` output of type `file` answers it as `files.value`.
- In `lf`, a `"pdf"` kind that only meets the host at run time (`File.from(t, kind)`) fails naming the plugin, and `lf`'s own writer is gone.

### n-kg

- **The knowledge graph is a module, `@lf/kg`, that the platform supplies.** Movements import and use it exactly as before (`` `@lf/kg` ``, `connect kg`, the same record types, edges, `Record Change` event and listen settings); versions 1 to 4 keep their behaviour. The module reaches the graph only through a store the platform hands it, so nothing about the graph is built into the engine any more.
- **A graph change now runs its listening movements as queued work, never inside the API process's graph loop.** With `KNOWLEDGE_MUTATION_DELIVERY=local` (the default), the automations drain takes each change off the graph's outbox and queues one receipt and one run per matching listen, as for any adapter's webhook; the server's drain loop or a scheduled `drain:once` runs them. Each change is stored as a trigger event (visible and replayable like a webhook's), and the run-mode, loop-guard and `suppress_self` gates apply as they do to every other source. No setting changes. In a process that mounts `knowledge` without `automations`, `local` events now wait undelivered instead of failing on a backoff (`up.sh` already sets `webhook` there).
- With `KNOWLEDGE_MUTATION_DELIVERY=webhook`, a graph listen's `type:` and `fields:` now narrow which changes fire it (before, that path did not check them, so any change could start any graph listen), and its signed deliveries are held to the platform's rule for signed inbound (subscriptions that existed before keep their old leniency).

## [0.12.0-rc.2] - 2026-10-19 (pre-release)

This is a pre-release for trying out, not the full 0.11.0 line's replacement: container images are
published at this tag only (never `latest`), npm packages under the `next` tag, the GitHub releases
are marked pre-release, and the docs are under `/docs/next/`. The big change is language version 5; the
rest of this section is its detail.

**Language version 5, Dancing Wren, is a PREVIEW.** Existing automations keep their version 1 to 4
pins and run unchanged. Version 5 is opt-in: an automation moves to it only through the explicit
upgrade (`lf upgrade`, or `upgradeAutomation` through the API), never by an ordinary edit or the
release itself. Expect the version 5 rules and their diagnostics to still shift before the full
release.

Language version 5, **Dancing Wren**, arrives. New automations are written in it. Every change in
it is a refusal, so an automation that uses a retired form has an error under 5, stays on its
version, shows Review and behaves exactly as before; rewrite the form and upgrade (`lf upgrade`,
or `upgradeAutomation` through the API). Versions 1 to 4 keep their behaviour (proved by a version
4 conformance corpus). Every rule, with rewrites, is in the [Dancing Wren migration
guide](docs/language/dancing-wren-migration.md).

**An upgrade rewrites the old spellings, when asked.** `upgradeAutomation` (and the agent tool)
first rewrites an automation by the fixes the checker offers under 5 that are marked safe (they
provably keep the meaning), and lists the others with their rewrite (`applyAllFixes` applies them
too); only the rewritten text is judged, and when it is clean the text and the pin move in one
save. An automation left with errors keeps its text and its pin, and what is left is listed
against the rewritten text. The deploy check never rewrites an automation's text: it moves a pin
only when the text as written is already clean under the newer version, and otherwise tells the
team an upgrade can rewrite it. For a local project, `lf upgrade` rewrites the movement files in place
(`lf upgrade --check` prints the diff); `pnpm --filter movement-lang language:upgrade` does the same
for any file or a program on stdin. `AT(x, "k")` is rewritten to `x["k"]`, which keeps a record's
refusal (`x.k` would read the field). A narrowing a host registers matches a hop's WHERE however
the field read is spelled (`e.action` under 5, `action` before). Comments and layout outside the rewritten spans are kept byte
for byte; on text already in the version 5 spelling it changes nothing.

**Every built-in integration is now a module, and the six bundled plugins are one.** Granola,
Evertrace, Dropbox, Google Sheets, Google Drive, Gmail, Affinity, Airtable, Attio, Telegram and
Slack run from `modules/<name>`, and the bundled plugins from `@lf/web`; the platform loads each in
process and `serve-module` serves the same code everywhere else. For a team nothing changes: each
was held to a recording of its old adapter (same requests, answers and writes), webhook URLs,
signatures and stored credentials are untouched, and each can be switched back with one line.
**Action may be needed:** Affinity, Airtable, Attio and Slack webhooks whose subscription has no
signing secret (missing, blank or a placeholder) are now refused; Affinity needs the account's
Webhook Signature Key, then the listen registered again. The API logs at boot how many live
subscriptions this refuses. A separately run module's server secret now belongs to its install
and the provider credential to the connection (`connect … using …`), on the platform, in `lf` and
in `lf-host`; one new nullable column, `external_service_credentials.declared_credential`. A
module served as a process hands out its files' bytes at one-use URLs under `MODULE_PUBLIC_URL`
(else the address it binds), never under the address a caller claims. Off the platform, `@lf/web`
refuses a LinkedIn profile or gated document address by name. The sections below, one per stream
(`ev4-*`), have the detail.
### r-fileown
- **Files uploaded before the upgrade are readable again by the team that used them.** A migration gives each older upload (stored as `<uuid>/<name>`, such as a Run-now upload a parked run still holds) the document row the file check reads, for the one team whose events, runs, parks, callbacks, asks or documents reference it. A file two teams reference gets no owner (the deploy log counts them); a file nothing references stays unreadable. The check itself is unchanged.

### r-rehearsal-fixes

- **The `migrate` log no longer shows the database password** (the runner reads `DATABASE_URL` from the environment; the AWS and Fly guides stop passing it as an argument). **The MinIO warning ends once the copy is done:** a successful `copy-from-minio` records `minio_copy_done` in the config volume. **`up.sh --demo`** now starts the fake CRM the seed needs. **`POST /automations/run`** accepts an automation name.
### r-guardslot

- **The loop guard is a core slot, off by default.** What `r-loopguard` built into the run host is now the `loopGuard` slot, filled by `@lf/fingerprint-guard` when `lf.yaml` says `core: { loopGuard: "@lf/fingerprint-guard" }`. With no guard, neither lf nor the platform suppresses anything and a movement's own write echoing back runs it again (the platform's `suppress_self` flag is unchanged). The guard's memory moved out of the store: its own file `.lf/guard.db`, or a shared Postgres database (`url`, schema `lf_guard`); the store wire's `writes.*` methods and Postgres migration 3 are gone. Wire and contract suite: [loop-guard-slot.md](docs/contracts/loop-guard-slot.md). `examples/lf-attio` opts in.
- **Who issues a webhook's signing secret** is declared: a module's `inbound` may say `secretIssuedBy: provider` (adapter protocol 2, additive; absent means `installer`). `lf connect` then asks for no webhook secret, and `lf serve` (and the platform's listen reconciliation, for a built-in) withdraws a registration that returns none while none is held. `@lf/attio` and `@lf/airtable` declare it.
### r-grandfather

- **Existing webhook subscriptions keep the old leniency.** Every subscription row present when this release's migration runs is marked `grandfathered_unsigned`; while it holds no usable secret, Attio and Airtable verify as before (against an empty key) and Affinity accepts any delivery. Setting the secret makes it strict. New subscriptions are always strict. The boot log counts grandfathered unsigned subscriptions per module.
### r-attio-walk

- **`lf serve` registers a source's webhook itself.** On start, each module that registers webhooks (`ensureEventSubscription`, e.g. `@lf/attio`) gets one for the events its live listens name, at `<publicUrl>/api/public/webhook-sync/<provider>/<credential>`; the id, events, URL and the secret the source issues are kept on that credential, so a restart changes nothing and a removed listen removes the webhook. `lf connect <module> --base-url / --oauth-authorize-url / --oauth-token-url` point a module and its sign-in at a fake or proxy. `@lf/<name>` resolves in the workspace lf was built in. Attio's `record.created` and `record.deleted` carry an idempotency key, so a redelivery runs nothing. Walkthrough: [examples/lf-attio](examples/lf-attio/README.md).
### r-json

- `lf` gains `--json` on `check`, `catalog`, `run`, `resume`, `call`, `cancel`, `runs`, `connect` and `credential list`: one stable JSON document per command, so agents need not parse the human text (docs/lf-json.md). New `lf runs show <run-id>`: one run's status, event, trace, writes, cost and what it is parked on.
### r-doclinks

- Every hover link the language server emits points at a real built docs page and heading, under one base constant (`https://listen-fire.github.io/listen-fire`); a test builds the site and checks each. `lf-json` joins the site; `Text.includes` and `List.includes` get handbook entries.

### r-lsp

**`lf lsp`, a language server for movement files.** Diagnostics (the Rust checker, against the project's catalog, 200 ms after an edit), completion (what is in scope, fields after `.` and through a hop's alias, the edges a walk can take next, built-ins as version 5 spells them, module tags in imports, a listen's settings keys, credential names after `using`), hover with a link to the versioned docs, go to definition, and the checker's fixes as quick fixes. The service is the new crate `listen-fire-language`, written from scratch over the checker's own results ([docs/contracts/language-service.md](docs/contracts/language-service.md)).

### r-limits

- Drain pools: `lf drain --kinds poll_listen` (or `resume_timer,wake_await,fire_event,fire_callback`, and `cron` for the cron ticks) claims only work of those kinds, so polls and run steps can be drained by separately sized fleets. Both stores and the store wire (`work.claimDue`'s `kinds`) take the filter; the run host contract holds every store to it.
- Provider limits: a module (and a models provider) may declare `limits` in its manifest (`{ scope: credential | module | install | team, calls, per, concurrent }`) and answer `retryAfter`. A new core slot, `limiter`, keeps them: lf and the platform ask it before every module call and model request and wait in process while it refuses. The default, `@lf/memory-limiter`, counts in one process (the 8-requests-in-flight model cap is now `@lf/anthropic`'s declared limit); a limiter shared by many hosts is a module filling the slot over [its wire](docs/contracts/limiter-slot.md). The engine knows nothing of limits.

### r-async

- Embedding the engine in Rust: the typed host interface is always asynchronous, in one shape. Every host trait method returns a future (`HostFuture`; an in-memory host returns `embed::ready(…)`), and `embed::run`, `resume` and `fire` are async. A run starts every request the engine has pending at once and answers each as it lands, in any order, as `lf` does over the JSON route: two 100 ms calls in the arms of an `all(...)` take 100 ms, not 200. Plain futures, no runtime dependency. **Breaking** for an embedder of 0.11.0's synchronous traits (not yet published).
### r-every

- A polled listen's own poll interval is spelled `every: 5m` from language version 5 (`listen to feed { every: 5m } fire seen`); versions 1 to 4 keep `pollIntervalSeconds: 300`, and under 5 that key is `MOV_V5_SPELLING` with the `every` fix. The platform's poll worker and lf both read it; every polled lf module accepts it.

### r-docsite

- A static documentation site built from the repo's handbook, guides and contracts: `pnpm docs:build` writes `site/docs/v5/<page>.html` (anchors stable, URL scheme in `docs/README.md`) and checks its links; the `docs` workflow publishes to GitHub Pages on a `docs-v*` tag or manual run only.

### r-poll

- lf polls a module that declares `poll: { intervalSeconds }`: `lf serve` on the interval, `lf drain` when due (a poll missed while no worker ran is one poll; one worker at a time per listen, under the work queue's lease), `lf run --poll <movement>` at once. The module's checkpoint is kept per listen in either store (no migration); each event runs the listen as a webhook's does. A listen with no webhook source (Granola, Evertrace, Dealroom, Gmail's poll) now fires in lf.
- lf's result check keeps an event's `idempotencyKey` (it dropped it), so a redelivered webhook or poll event runs a listen once.

### r-units

- `cron` and `manual` are run-host units (from language version 5): in every file's scope, already connected, with no import — `listen to manual fire hello`, `listen to cron { schedule: "0 9 * * 1" } fire digest`, the parameter typed `<manual-[:Invocation]->>` / `<cron-[:Tick]->>`. A file's own import or binding of the name replaces the unit; `connect manual` is told to listen by name. Versions 1–4 unchanged. Both checkers, the Rust engine, the platform's listen derivation (trigger rows, Run now) and lf.
- lf: the units are built in (catalog, `lf check`); `lf run <movement>` fires a manual invocation; `lf serve` and `lf drain` fire each cron listen's due tick, a tick missed while no worker ran once on the next drain (the occurrence's receipt keeps it to once across workers). `lf init`'s starter is `listen to manual fire hello`, so init → check → run needs nothing installed.

### r-crates

- The Rust crates are ready to publish (not published): `listen-fire-parser`, `listen-fire-checker`, `listen-fire-engine`, and the facade `listen-fire`, which re-exports them and installs `lf` (`cargo install listen-fire`; crates/lf is that crate, its CLI dependencies behind the default `cli` feature). All four at 0.11.0; `cargo publish --dry-run` of the four together is green. `cargo build -p lf` is now `-p listen-fire`.
- Embedding the engine in Rust: `listen_fire::engine::embed` checks a movement and runs/resumes it on an event, its host families as traits (store, models, judge, files, adapters, modules, secrets, clock and ids, trace) over the same requests the WASM boundary carries. [`examples/rust-embed`](examples/rust-embed) is a toy game loop running a movement when a monster is slain. `embed::resume` takes why the flow is woken (`Wake::Timer` or `Wake::Arrival`: an awaited adapter record or callback call re-enters the await), `embed::fire` runs a called callback's body, and a model, judge, plugin or file read can refuse on the run's budget (`HostFailure::budget`). Real movements (an `ai` call, an extraction, the identity judge, files, a plugin, awaits, callbacks, a join) are run through this typed route and the JSON route in `crates/movement-engine/src/embed/end_to_end.rs`.

### r-embed

- Embedding: a product can let its customers write and run movements in its own process ([docs/embedding.md](docs/embedding.md), [`examples/embed-saas`](examples/embed-saas)). New entry `@listen-fire/engine/public/embed` (the in-process host, adapter introspection, the listen routing table, priced model clients); `RunInput.limits` carries the segment limits from a TypeScript host, and `movement.wasm` is rebuilt so they hold.
- The packages are ready to publish (not published): `@listen-fire/engine` (was `movement-engine`), `@listen-fire/engine-contracts`, `@listen-fire/module-kit`, `@listen-fire/movement-lang`, `@listen-fire/shared`, `@listen-fire/file-text`, `@listen-fire/model-providers` and every `@lf/<module>`, each 0.11.0, built to `dist/` with declarations by `scripts/build-packages.cjs` on `pnpm pack`. Sources still import the old spellings through workspace aliases; `pnpm --filter` takes the new names.
- Merged onto r-boundary: the published `@listen-fire/engine` serves only `public/*` (its `publishConfig.exports`); in the workspace the internals still resolve only under the `movement-engine-internals` condition. The engine's own tests reach internals by relative path, not the old package name.

### tidy-arith

- **From language version 5, arithmetic on a value that may be absent is refused** (`MOV_ABSENT_REQUIRED`): `+ - * / %`, unary `-`, a built-in's number parameter, and `List.sum`/`avg`/`min`/`max` over a list that may hold an absent member. Why: the engine reads an absent value as 0 there, silently. Guard it, `coalesce` it, or `List.compact` the list; the diagnostic writes the guard and the fallback from the operand. Versions 1 to 4 run as before; a move up across 5 is an upgrade warning ([migration guide §18](docs/language/dancing-wren-migration.md#18-arithmetic-needs-a-number-that-is-there)).

### tidy-filternarrow

- **From language version 5, `filter(xs, (x) => x != null)` answers a list of present members**, as TypeScript's inferred type predicate types `xs.filter(x => x != null)`. The narrowing is the function's own test: every `return` that may keep a member must prove it present (`!= null`, `!(x == null)`, a conjunction, a guard clause that returns `false`). So the filtered list clears `MOV_ABSENT_REQUIRED` on `List.sum`/`avg`/`min`/`max`, whose fix now offers this form too. Versions 1 to 4 unchanged ([migration guide §18](docs/language/dancing-wren-migration.md#18-arithmetic-needs-a-number-that-is-there)).

### tidy-rust2

- A third-party store module fills lf's store slot: an externals folder whose `lf-external.yaml` says `kind: core`, `slot: store` and its `command`, named by lf.yaml's `core: { store: <name> }`. lf starts it and speaks the store slot's wire to it, JSON-RPC on its stdin and stdout ([docs/contracts/store-slot.md](docs/contracts/store-slot.md), within adapter protocol 2): the methods `lf --contract-store` serves, plus `store.open` with the module's settings. `lf connect <name>` asks its declared settings and opens it once. `lf --contract-store-slot` serves the project's store slot, so the run host's contract suite runs through a module. The models, judge and files slots still take only a built-in.
- An event with an `idempotencyKey` runs each listen once: a redelivery runs nothing and `lf run` says so. A dry run notes no receipt. The receipts are the SQLite state file's new `event_receipt` table and @lf/postgres-store's migration 2 (`lf.event_receipt`); **a Postgres store needs `lf connect @lf/postgres-store` once** to apply it (lf refuses a schema at version 1 until then).
- The host's models door is served outside `lf serve` too: under `lf run`, `resume` and `drain` a process module's `ctx.models` reaches the models slot (LF_HOST_URL is a loopback listener with the models door alone; a push to it answers 404).

### tidy-rust

- `lf` is built from the Cargo package `lf` (`crates/lf`; was `lf-host`): `cargo build --release -p lf`. `lf --version` prints the crate's version, now 0.11.0 with the packages; the release workflow refuses an `lf-v<version>` tag that names another.
- At most eight model requests are in flight from one `lf` process, as the TypeScript client allowed. `EXTRACTION_OUTPUT_BUDGET=1` (or `true`) switches on the extraction loop guard in `lf` as on the platform: a ceiling sized from the call's input (8,000 to 32,000 tokens) and one continuation.
- A model reply's broken JSON is repaired by a port of the npm `jsonrepair` 3.8.0, held to the TypeScript engine's reading over a corpus of 114 malformed replies. The crate it replaces read 32 of them differently: a truncated list lost its last entry, and a truncated reply with escaped quotes turned into made-up keys.
- Past a segment's wall clock, what is in flight gets five seconds to finish; then a read or a model call is dropped, and a write to an external system is waited for to its end, never cut off half-sent.
- A limit a segment meets (`MOVENG_LIMIT_*`) is never swallowed: a read the engine makes to push a filter down and an await's re-check after parking pass it on, and a `map` or `all` reports it over an earlier member's failure that `onError` could forgive.
- An adapter call's answered `cost` (adapter protocol 2) rides the answer into the engine's ledger (`adapters.call` answers take an optional `cost`), so the cost cap counts it before the segment's next priced call rather than from the next segment.
- @lf/sqlite-store's `path` setting is refused unless it names a file in a folder that exists. `lf connect @lf/judge` and `lf connect @lf/local-files` write no empty entry to the secrets file.

### r-retire

- The Rust binary is now `lf` (Cargo package and bin `lf`, in `crates/lf`; usage text, release workflow, container image and docs follow). The TypeScript `lf` is gone: `apps/cli` is only the test harness that drives the built binary (`LF_BIN`, default `target/debug/lf`). Tests that compared the two were dropped.

### r-boundary

- The platform reaches the engine only through its public entries (`movement-engine/public/*`): 603 internal imports in apps/api (plus apps/cli and model-providers) now name a public entry, the guard's baseline is empty, ESLint refuses an internal import, and the package's `exports` map refuses one at run time. Engine tests still in apps/api reach internals under the test runners' `movement-engine-internals` condition.
- 39 engine-only test suites moved from apps/api into packages/movement-engine (`pnpm test` there); the rest still need the platform and stay.
### r-deploy

- A container image for the Rust `lf` (`deploy/lf/`): `lf serve` for the webhook and callback doors and `lf drain --until-idle --max-seconds N` for workers, on the Postgres store (`LF_STORE_URL`, TLS). A compose file for a local trial and a page on scale-from-zero platforms. `serve` listens on the address `LF_BIND` names (default loopback).
### r-slots

- Core services are modules filling slots. lf.yaml's `core:` names the module per slot (`models` @lf/anthropic, `judge` @lf/judge, `store` @lf/sqlite-store or @lf/postgres-store, `files` @lf/local-files; each slot defaults to the first). `lf connect <core module>` asks its settings and runs its setup: @lf/postgres-store creates and migrates its own `lf` schema and no longer touches the hosted product's tables, and now keeps pull cursors. lf.yaml's `store:` is refused with the way over (`core: { store: … }`); `--store` still names a store outright. The deploy image reads the store's settings from `LF_SECRET__POSTGRES_STORE__*` and runs the setup as a one-shot service.
- Adapter protocol 2, additive: a manifest may declare `kind`/`slot`, `settings` and `hostModels`; requests carry `credentials` (every declared one) and `settings`; answers may carry `cost` (charged to the run's spend, counted by the cost cap); the `credential_refused` code makes the host refresh and retry once; the host's models door (`POST …/adapter/<type>/models`); events carry `idempotencyKey`.
### r-dist

`lf` ships as a download. Tagging `lf-v<version>` builds `lf` for macOS (arm64, x64) and Linux (x64, arm64, static) and attaches the archives and `SHA256SUMS` to a GitHub release (`.github/workflows/lf-release.yml`); `scripts/dist/install.sh` verifies the checksum and installs to `~/.local` (or `--system` for `/usr/local`). `lf init [dir]` scaffolds a starter project (`lf.yaml`, one movement that checks clean, `.gitignore` for `.lf/` and secrets). Built-in modules ride in each archive (`share/lf/modules`, found beside the binary or at `LF_MODULES_DIR`); an external names one as `module: "@lf/dealroom"`. Modules are TypeScript, so running one needs node.
### r-safety

- A segment now has host-set limits with safe defaults: a step budget, one text's size, one list's or map's size, and the result's size; past one the segment ends coded `MOVENG_LIMIT_*`, never forgiven by `onError`. lf reads them from `MOVEMENT_MAX_STEPS`, `MOVEMENT_MAX_TEXT_BYTES`, `MOVEMENT_MAX_COLLECTION_ITEMS`, `MOVEMENT_MAX_RESULT_BYTES`, and keeps a per-segment wall clock (`MOVEMENT_MAX_SEGMENT_SECONDS`, default 900). The table and the network review: [docs/contracts/run-limits.md](docs/contracts/run-limits.md).
- The engine itself refuses a model call once the run has spent its cost cap, so the cap holds on any host.

### lfr-upgrade

- `lf upgrade [--check] [--all]` rewrites a project's movement files by the Rust checker's own fixes, with the TypeScript `lf upgrade`'s output, exit code and resulting file text.

### r-docs

- [Getting started with `lf`](docs/getting-started-lf.md): init, write, connect a module, add a credential, run, serve. The handbook chapters and `examples/lf-acme` already read in the version 5 surface and check clean.

### Language version 5, Dancing Wren: what breaks

- **A field read off text is refused** (`MOV_TEXT_HAS_NO_FIELDS`, from version 5). `t.Name` where
  `t` holds text reads nothing: both engines answer null. Why: a text has no fields, and a read
  that always answers null is a mistake the checker said nothing about. Under 3 and 4 it is a
  warning, and the program runs as before.
- **The everyday spelling outside walk brackets** (`MOV_V5_SPELLING`, with the exact rewrite as
  the diagnostic's fix). Why: code that runs step by step reads like TypeScript, so a model or a
  person writes it right first time, and a walk's brackets read like a query because the source
  system may run them. Core words are lower case (`map filter reduce count first only exists
  coalesce sort members ai fail`); the other built-ins live in namespaces (`UPPER(t)` is
  `Text.upper(t)`, `DATE.TODAY(z)` is `Date.today(z)`, `SUM(xs)` is `List.sum(xs)`); `&& || !
  c ? a : b true false null` replace `AND OR NOT IF … END TRUE FALSE NULL`; `ISNULL(x)` is
  `x == null`, `EXISTS(value)` is `value != null`, `AT(xs, i)` is `xs[i]`; settings go last
  (`map(xs, f, { concurrency: 2 })`, `ai(p, { tier: "careful" })`, `await until(c, { every: 1h
  })`); `ERROR` is `fail`; `movement` is `function`; an `if` condition is parenthesised; an
  adapter is set up with `crm = connect attio using acme { dryRun: true }` and imported by its
  package tag (`` import { `@lf/attio` as attio } from adapters ``). Inside walk brackets the
  words stay CAPS (`WHERE … AND … CONTAINS`), and a field is read through the hop's alias
  (`-[c:Companies WHERE c.Name == n]->`); a bare name there is only ever a variable, so
  `c.Name == Name` compares the field with a variable of the same name. Messages name built-ins in the program's own version's
  spelling. Upgrade with `lf upgrade` or the API's upgrade, which apply every fix, check the
  result under 5, and move the pin only when it is clean. The handbook, the examples and the
  [migration guide](docs/language/dancing-wren-migration.md#2-the-everyday-spelling) show only
  the new spelling.
- **`write … bind` is retired** (`MOV_WRITE_BIND_RETIRED`). Why: the engine kept the
  correspondence in a store no system holds. Store the link in the system that holds it: a field
  the next write finds the record by (`unique by`), or an edge there.
- **`#` hops are retired** (`MOV_META_HOP_RETIRED`): `-[:#name]->`, `-[f:#resources]->`, on a walk,
  a head, a write or match target, or a type's address. Why: there are no meta edges, only the edges
  a system declares. A plugin is a function: `-[:#transform { plugin: … }]->` (refused since 3)
  now shows the call form, `import { p } from plugins` then `out = p(…)`.
- **`delete` only where the system declares it.** `MOV_DELETE_NOT_DECLARED` when the record's type
  does not say `deletable: true` in its describe; `MOV_DELETE_NOT_RECORD` when the target is a
  value, a list, an extracted node, a record the run built, or anything but one stored record.
  Why: each passed the save and failed at run time.
- **`_resources` only on an extraction's result** (`MOV_RESOURCES_NOT_EXTRACTED`). Off a system's
  record, walk the edge it declares to its files, which the message names from the schema: email,
  Gmail and WhatsApp `Attachments`, Slack `Files`, the knowledge graph `Resources`. Why: the
  reserved reference was read through the event's adapter whatever the record's system, and read
  nothing on the systems that had retired its bundle. Under 5 the engine no longer resolves it
  for a system's record.

- **A file is never joined into text** (`MOV_FILE_IN_TEXT`): `"Attached: ${f}"`, or a value that
  may be a file. Why: it joined as `[object Object]`. Its text is `READ(f)`
  (`"${COALESCE(READ(f), "")}"`); the file itself goes into a field that holds files.
- **A write handle's unsent file is not a file** (`MOV_HANDLE_FILE_NOT_SENT`): `READ(h.doc)`, or
  `h.doc` passed where a file is expected, when the write did not send `doc`. Why: the system
  answers with its description of the file, not a file, so `READ` failed at run time. Read the
  record back through its edge to get the file, as a walk read does; a field the write sent stays
  usable.
- **A value that may be a record, handed to a record parameter** (`MOV_CALL_ARG_MAYBE_RECORD`):
  `v = COALESCE(org, "x")` then `hp(r: v)`, an `IF` of a record and text, or a function or closure
  that returns either. Why: TypeScript's `Org | string` is no `Org`, and the engine refuses the
  value at run time. Narrow it to the record with `IS`, handle the case where it is not one, or
  fill the other arm with a record. A union of records alone is one record and still fits. A record with
  `NULL` is a maybe-absent record and fits. Inside an `IS` arm the value is the record (on every
  version, it passes as a position and enters a graph).
- **A value that may be a record, handed to a value parameter** (`MOV_CALL_ARG_MAYBE_RECORD`):
  `f(COALESCE(co, 1))` or `f(IF c THEN co ELSE 1 END)` where `f` takes `<number>`, or a name bound
  to either. Why: TypeScript's `Org | number` is no `number`. Under 3 and 4 the check said nothing,
  and the call ran with the record where the number was typed (a sum over it came out `NaN`), so
  the refusal is new under 5. Under 3 and 4 it is a warning that blocks the move up. Narrow it to
  the record with `IS` and pass a field off it, or fill every arm with a value. A plugin argument
  and a written field already refused it on every version. A built-in's argument that takes a value
  is held to the same rule: `ROUND(COALESCE(co, 1))`, `UPPER(COALESCE(co, "b"))`. Under 3 and 4 the
  built-in ran on the record as it was (`NaN`, `"[OBJECT OBJECT]"`), so there it is a warning too.
- **A call of one of several closures is held to every one of them**: a function or closure
  whose returns hand back different closures (`return made` on one path, `return label` on
  another), then `g = mk()` and `g()`. The call takes only what every closure takes (each arity,
  and an argument that fits each parameter; two closures whose parameters share no argument are
  named, `MOV_CALL_ARG_TYPE`), and its value is any of their returns, so a record a later one hands
  back is refused where it is written (`MOV_WRITE_FIELD_TYPE`). Why: TypeScript calls a union of
  function types this way. Under 3 and 4 the call was typed by the first closure alone and ran on
  whichever it reached (a record written into a text field, a number into a text parameter), so
  under 3 and 4 each is a warning that blocks the move up (`MOV_CALL_ARITY`, `MOV_CALL_ARG_TYPE`,
  `MOV_CALL_CLOSURE_RETURNS`). A declared return type (`): <() => <text>>`) narrows the closures
  to it.
- **A collection op's members are held to its function's parameters** (`MOV_CALL_ARG_TYPE`,
  `MOV_CALL_ARG_MAYBE_RECORD`): `MAP(["a"], (n: <number>) => n)`, or a function by name, under
  `MAP`, `FILTER`, `GROUPBY`, `KEYBY` and `REDUCE` (whose starting value is held to its
  accumulator). Why: the op calls the function with each member, and TypeScript refuses
  `["a"].map((n: number) => n)`. Under 3 and 4 nothing compared them and the op ran with the member
  as it was (a sum over text came out `NaN`), so under 3 and 4 it is a warning that blocks the move
  up. Type the parameter as the members are, or leave it untyped to take their type.
- **A record a `race` arm hands back reads as that record** (and so does a slot of `all`, which
  replaces `parallel`). `AT(r, 0).name`, or `h = AT(r, 0)` then `h.name`, reads the record
  the arm returned, as `AT([a, 2], 0).name` on a list does; `AT(r, 0) == null` is false. Under 4
  and earlier that slot read null while the check accepted the read, and a program pinned there
  still reads null. A move up across 5 warns a read of such a receipt (`MOV_RECEIPT_RECORD_SLOT`).
- **`count(xs)` counts every item of a list, an empty one (null) included**, as TypeScript's
  `.length` does. Why: `count` is the one way to ask a list's length from 5 (`LENGTH(xs)` is
  rewritten to it), and `LENGTH` counted every item. Under 4 and earlier `COUNT` skips empty items,
  and a program pinned there still does. A move up across 5 warns a count of a list that may hold an
  empty item (`MOV_COUNT_COUNTS_EMPTY`). The rewrites `LENGTH(xs)` → `count(xs)` and `EXISTS(xs)` →
  `count(xs) > 0` of a list keep the meaning, and are marked safe to apply automatically.
- **A hop over records the run already holds keeps its ORDER BY and LIMIT**: an extraction's
  entities (`deals-[c:company ORDER BY c.rank]->`), a `node { … }` or `graph { … }` literal's
  entries and the records written onto a local node, in a block head, an expression and `exists`.
  Under 1 to 4 those two were silently not read there (only `exists` read them). Why: a hop means
  the same thing whatever it walks over. A move up across 5 warns each such hop
  (`MOV_IN_MEMORY_HOP_ORDER`): its result may change.
- **`found != null` on the records a block returned says whether it returned any**, as
  `EXISTS(found)` does. Why: from 5 `!= null` is how a program asks what `EXISTS` asked of a
  value. Under 4 and earlier those records always counted as present, so the test was always true,
  and a program pinned there still reads it so. A move up across 5 warns each such test
  (`MOV_PRESENCE_OF_RETURNED`).
- **`parallel` is retired for `all`** (`MOV_PARALLEL_RETIRED`). `all` is the same join with its
  functions passed as arguments, as TypeScript's `Promise.all` takes its promises:
  `r = await parallel([a, b])` is `r = all(a, b)`, which the diagnostic applies for arms written
  down. The answer is the list of what each arm returned, in argument order, so `AT(r, i)` reads
  what the receipt's slot did. It takes `MAP`'s `concurrency` and `onError` as a settings record
  written last (`all(a, b, { concurrency: 2 })`); every arm runs at once without one, and an arm
  whose failure `onError` forgives leaves its slot null. Arms built at run time are rewritten by
  hand, naming each function. The `parallel { … }` block refusal points at `all` under 5.
- **The extraction keyword is retired** (`MOV_EXTRACT_KEYWORD_RETIRED`): `x = extract from [a, b]
  { node c: "…" { … } }`, with its inline node shapes and `through […]` stages. An extraction is
  the call over a declared node shape: `extract(content, Shape, { tier })` for each record the
  content holds, `extractOne(…)` for the one it describes, and a plugin is called as a function
  (the handbook's enrichment example composes them). Why: one way to extract, whose shape is an
  ordinary declaration. The diagnostic's fix declares the tree as `node XShape` (named after the
  binding, numbered past a name the file holds) and writes `x = extractOne([a, b], XShape, {
  tier })`: the one record the keyword's result was, its fields and nodes read as before. It is
  never applied on its own: that record may be absent where the keyword's result never was (a
  field read off it then needs a fallback), an untyped field becomes `<text>`, and the model is
  asked through the call's prompt. A `through […]` stage has no fix, since no composition of
  plugin calls is provably the same: rewrite it as the enrichment example does.
  **The Rust engine no longer runs the keyword on any version** (its code is deleted). A
  version 1–4 automation holding one still runs on the TypeScript engine, by its version,
  exactly as before.
- **A block's walk off a record that may be absent is refused** (`MOV_ABSENT_REQUIRED`, from
  version 5): `found-[c:company]-> { … }` where `found` is an `extractOne(…)` answer, a `match`
  that may find nothing, an unguarded pick (`only(…)`, `first(…)`, `rows[0]`). Why: the run does
  not skip such a block when the record is absent, it fails at the walk ("'found' is nothing, and
  a hop walks from a POSITION"), on every version and both engines; the checker had read it as a
  block that runs zero times. Guard the walk: `if (found != null) { found-[c:company]-> { … } }`.
  Under 1–4 nothing changes (a saved automation runs whenever the record is found); a move up
  across 5 is an upgrade warning, which holds the pin. The write-site refusal of the same records
  no longer offers the block as a way out from 5.
  A guard is any branch that always leaves (`fail(…)`, a `return`, an `if` whose every arm and
  `else` leave): below it the record counts as present, as below `if ISNULL(x) { ERROR(…) }` on
  1–4, and `x != null && …` sees `x` present on the right side. Nothing else narrows.
- **A null test on an extracted `<text>` field is refused for the call's records too**
  (`MOV_PRESENCE_TEST_ON_TEXT`, from version 5): `if (r.title != null)` where `r` is a record
  `extract(…)` or `extractOne(…)` handed back and `title` is `<text>`. Why: a text the model did
  not find is `""`, never absent, so the test always answers the same; the keyword's result has
  been refused since version 2, and versions 3 and 4 let the call's through. Annotate the field
  `<text | null>` to keep the test, or test `r.title != ""`. Under 3 and 4 nothing changes; a
  move up across 5 is an upgrade warning, which holds the pin.
- **`race` and `all` take their arms as arguments** (`MOV_COMBINATOR_ARMS_ARE_ARGUMENTS`):
  `race([q, t])` is `race(q, t)`, which the diagnostic applies. Why: a closure is not data, so there
  is no list of them to pass. A name that is not a function is refused where it is passed
  (`MOV_COMBINATOR_ARM_NOT_FUNCTION`).
- **No `await` on `race` or `all`** (`MOV_COMBINATOR_NO_AWAIT`): `r = await race(q, t)` is
  `r = race(q, t)`, which the diagnostic applies. Why: `await` marks only where the run itself
  parks (a sleep, an until, an answer read with `await FIRST(…)`), and a combinator does not park
  by itself; its arms may, and the run parks where they do. Versions 1 to 4 keep `await race([…])`
  and `await parallel([…])` exactly.
- **A callback's call that leaves its function a parameter open** (`MOV_CALL_ARITY`):
  `callback(() => book("Acme"))` where `book` takes two. Why: `() => f(x)` is a closure that takes
  nothing, so, as in TypeScript, it passes every argument itself; what the platform sends when the
  callback fires is a parameter the closure declares (`callback((d: <date>) => book("Acme", d))`).
  `callback(book)`, a function named bare, still leaves every parameter to the platform. Versions
  1 to 4 keep `callback(book("Acme"))` filling the last parameter at fire time. The diagnostic's
  fix writes the closure from `book`'s own declaration (each open parameter under its name and
  type). It is not applied on its own: both engines refuse to run the old form at fire time, so
  the rewrite turns a run that failed into one that fires.
- **A package of plugins imported without a name** (`MOV_V5_IMPORT_NEEDS_ALIAS`, the fix adds
  one): ``import { `@lf/web` } from plugins``. Why: its members are called through the name after
  `as` (`web.fetchUrl(u)`), and a tag is no name a program can write, so nothing could call them.
- **A record value handed to a plugin's text input** (`MOV_CALL_ARG_MAYBE_RECORD`):
  `research({ context: s })`, or a value that may be one. Why: as TypeScript refuses an object
  for a `string`, a text input takes text. Under 3 and 4 the record was passed through as it was,
  so there it is a warning that blocks the move up.
- **A value that may be one of several records reads only what every one offers**, as a
  TypeScript union. One rule types an `IF`, a `COALESCE`, a function's returns, a list literal's
  members and `MULTI`. Records of one type are that type (`A | A` is `A`). Records of different
  types (People or Companies) read a field every member has as the union of its types, and a field
  one lacks is `MOV_UNKNOWN_PROPERTY`, naming it. No arm is preferred: a field one arm proved present
  is present only when every arm proved it, and a function is no longer typed by its first return.
  Why: each ran unchecked (a missing field read null, or a missing value was written). Under 3 and 4
  what the rule refuses is an upgrade warning.
- **The same rule reaches three more places.** Calling one of several closures hands back the union
  of their records, so a read one record lacks is `MOV_UNKNOWN_PROPERTY`. A walk or a linked write
  off a held list of records (`both = [lead, co]`, then `both-[:Manager]->`) asks every member, so
  an edge one lacks is `MOV_TRAVERSE_UNKNOWN_EDGE` or `MOV_LINKED_UNKNOWN_EDGE`. An `IF` of plain
  values is what either arm may be: `IF c THEN p.Name ELSE p.Email END` may be absent, so a
  required field refuses it (`MOV_ABSENT_REQUIRED`). Why: each was untyped and ran unchecked. Under
  3 and 4 what this refuses is an upgrade warning; a closure value is called only from 5.
- **An undescribed event written into a json field is refused** (from version 5). An event whose system the catalog does not describe is still a record. Written into a json field (whole, inside a value, through a name, or handed back by a closure) it is refused at save (MOV_WRITE_FIELD_TYPE), as a described one is; before, the run wrote the engine's own description of it. A second name for it keeps the read refusal (MOV_EVENT_UNDESCRIBED). Versions 1–4 unchanged.
- **A file-level value holds a value only** (`MOV_FILE_VALUE_RUNS`, from version 5). A call to a function or a plugin (written whole or nested in the value), a write, an extraction, a walk, a wait, a callback or a node there is refused at save. The engines already failed such a run; a file's values are worked out before every run and again on every resume, so a call there would run, and spend, each time. A literal, a built-in's value, a closure and a construction stay.
- **A walk inside an expression off a record that may be absent is refused too** (`MOV_ABSENT_REQUIRED`,
  from version 5): `count(found-[c:company]->)`, `exists(found-[c:company]->)`, a hop read in a write
  field (`found-[c:company]->.name`), a hop in an interpolation or a condition, where `found` is an
  `extractOne(…)` answer, a `match` that may find nothing, an unguarded pick. Why: the run fails at the
  hop when the record is absent, as it does for a block, and the checker said nothing. `exists(found)`
  has no hop and answers false for an absent record, so it is allowed. Guard the walk:
  `if (found != null) { … }`. Under 1–4 nothing changes; a move up across 5 is an upgrade warning,
  which holds the pin.

- **Forms the engine does not run are refused at save** (from version 5; each message names the
  spelling that does run). Why: each passed the check and failed the run.
  - A linked write or match whose target walks more than one edge (`MOV_WRITE_MULTI_HOP`):
    walk to the parent in a block, then write off its alias.
  - A walk with no root, as a block head or in an expression (`MOV_WALK_ROOTLESS`): name the
    record it starts at. Only a rootless `exists(-[…]->)` inside a hop's WHERE or ORDER BY has a
    record to walk from (the one that hop lands on), so it stays, and it now also runs over a
    record the run built (an extraction call's nested record).
  - `unique by` on a write to a declared node (`MOV_WRITE_SHAPE_UNIQUE`): the record lands in
    memory, so there is nothing to find it in.
  - `KG_VALUE(…)` and `KG_EXISTS(…)` (`MOV_KG_QUERY_RETIRED`): walk the graph instead.
  - `await` on a name holding a list of records (`MOV_AWAIT_ON_LIST`): an await parks on one record.
  - A record written as the value of a field that is a relationship (`MOV_WRITE_LINK_FIELD`; before
    5 an info nudge): write off the record, or link the two after the write.
  - A walk off a json value (`MOV_JSON_HAS_NO_EDGES`): a json value has no relationships; read a
    key with a dot.

### Language version 5, Dancing Wren: it runs as Rust does, not as JavaScript did

Version 5 runs only on the Rust engine, so the machinery that copied JavaScript's quirks is gone.
Each line is a difference a version 5 run can show; versions 1 to 4 are unchanged.

- **Numbers print with Rust's shortest digits.** On a 17-digit tie the last digit can differ:
  `TEXT(16086.196899414062)` is `"16086.196899414063"` (JavaScript printed `…062`); both read
  back as the same number. The layout is unchanged (`1e+21`, `1.5e-7`, `0.000001`).
- **Letters and numbers are Rust's.** A FUZZY match's words split on what `char::is_alphanumeric`
  refuses, so a combining vowel sign no longer breaks a word (`हिंदी` is one word; it was `ह` and
  `द`). The CHUNKS entities estimate reads capitals with `char::is_uppercase`.
- **A regex group name is ASCII** (`$`, `_`, letters, digits): `(?<𝒜>.)` is a malformed pattern.
- **ONLY's failure quotes its argument as you wrote it.** `ONLY( [a,  b] )` fails with
  `ONLY([a,  b]) says there is exactly one, and there are 2.` (before, it re-spelled the
  expression in the old formula grammar).
- **LOWER and UPPER use Rust's Unicode tables** (Unicode 17; Node's ICU was 16). Letters Unicode 17
  gave a case now map: `UPPER("ꟓ")` is `"꟒"` (it stayed `"ꟓ"`). `ʕ` is no longer a cased letter, so a
  sigma beside it can lower differently: `LOWER("ΑΣʕ")` is `"αςʕ"` (it was `"ασʕ"`).
- **REGEX_EXTRACT reads whole characters and no Annex B.** `.` matches a whole emoji
  (`REGEX_EXTRACT("x😀y", ".(.)")` is `"😀"`; it was half of it); `\u{1F600}` names one. An octal
  escape (`\1` with no group was U+0001), `\c` without a letter and an unknown letter escape
  (`\p`, `\a`) are malformed patterns, so the call is absent. Escaped punctuation (`\-`, `\@`)
  is still itself. Groups nested past 1,000 deep are malformed (they were handed to TypeScript).
- **A date-time text is ISO 8601 / RFC 3339 only, and no offset means UTC.** `DATETIME("2024-03-05T10:00")`
  is `2024-03-05T10:00:00.000Z` whatever zone the host runs in (it was read in the process's local
  zone). A day the month lacks or the hour 24 is no date-time (`"2026-02-30T00:00Z"` rolled over
  to March 2). A comparison reads only ISO texts as dates: `"item 3" < "item 12"` is false, as
  texts (V8 read both as dates and said true); `true < "9"` no longer orders. Written dates
  (`DATE.PARSE("12 March 2026")`) are read as before.
- **Self-hosting: the engine's `builtins.function` request is gone.** A version 5 run never asks
  the TypeScript standard library for a reading; an unknown function fails the run
  (`MOVENG_RUNTIME: unknown built-in function`).
- **ROUND rounds a half away from zero:** `ROUND(-2.5)` is `-3` (it was `-2`); `ROUND(2.5)` is
  still `3`.
- **A number read from text is a plain decimal.** `NUMBER("0x10")` is absent (it was 16);
  `"0b101"` and `"0o17"` likewise. `"Infinity"`, `".5"` and `"5."` still read.
- **Whitespace is Rust's.** TRIM and a number read from text strip U+0085 and no longer strip
  U+FEFF (`TRIM("﻿ x")` keeps the mark); a regex's `\s` follows suit.
- **Fixed decimals round a tie to even.** A figure with a fixed number of decimals (compact
  numbers, a run's cost in its trace) rounds an exact tie to even: a cost of 0.03125 dollars
  shows `$0.0312` (it showed `$0.0313`).
- **Texts order by code point.** An ORDER BY, SORT or `<` over texts puts `"｡"` (U+FF61) before
  an emoji; JavaScript ordered by UTF-16 unit and put it after.
- **An empty text is no number.** `NUMBER("")` and `NUMBER("  ")` are absent (JavaScript's
  `Number("")` made them 0).
- **Self-hosting: values cross between the engine and its host as plain JSON.** A list is
  `["l", items]` and a map `["o", entries]`, in its own key order. `NaN`, `±Infinity`, `-0` and
  JavaScript's `undefined` cross as `null`; a lone surrogate crosses as U+FFFD. Nothing crosses by
  identity: an adapter that hands back the same object twice hands the engine two equal maps,
  and an object it changes after answering is not seen to change. A built-in function or
  `Object.prototype` no longer crosses; an adapter answering one is refused as any other
  non-JSON value is. A map member holding nothing is left out, as `JSON.stringify` leaves it.
- **A map is a map.** `__proto__` is an ordinary key and name: `{ __proto__: 1 }` holds it, a
  spread copies it, GROUPBY and KEYBY file under it, and a binding, a parameter, a field or a node
  may be called `__proto__` (`MOV_NAME_PROTO` and `MOV_SHAPE_FIELD_PROTO` now apply before
  version 5 only). Reading a key a map lacks is absent, whatever its name: `m.constructor` and
  `m.toString` were JavaScript's built-ins. `TEXT(m)` is `"[object Object]"` whatever keys `m`
  holds (a `toString` key no longer changes it). An extraction reply's field named after a
  built-in (`constructor`) reads as the reply wrote it.
- **A map keeps its keys in the order they were first set**, a number-like key included:
  `{ z: 0, "10": 1, "2": 2 }` lists `z`, `10`, `2` (JavaScript listed `2`, `10`, `z`). TEXT.SERIALISE
  still sorts keys, as texts: `"10"` before `"2"`.

- **A text counts and cuts by character.** `Text.length("😀 smile")` is 7 (it was 8: JavaScript
  counted an emoji's two UTF-16 units). `Text.split(t, "")`, a spread of a text, `Text.chunks`
  and every cut (a trace's 300-character prompt, a value cut at 200, a file bounded for the
  prompt) keep an emoji whole; nothing a run makes holds half of one. Self-hosting: a lone
  surrogate a host's JSON escapes (`"\ud83d"`) is read as U+FFFD, and a parked state, a trace or
  an error no longer writes the `\udXXX` escape back.
- **A field the record lacks reads nothing**, as it does on 1–4. Before, it read null, a value, so
  `node { body: msg.missing }` held a `body`, an `IS` test counted it present, and a write sent
  `body: null`. A field the record holds as null still reads null. For embedders: an
  `adapters.call` answer of nothing is `{}`, with no `result`.
- Not a run difference: the Rust engine's test fixtures for the built-ins, regexes, CHUNKS, file bounds and mixed-key sorts hold Rust's own answers, no longer regenerated from the TypeScript engine.

### Language version 5, Dancing Wren: new

- **`fail("…")` inside an expression**: `coalesce(x, fail("no x"))`, `c ? a : fail("…")`. It
  never returns, so its type is TypeScript's `never`: a choice between it and a value is that
  value (`coalesce(m, fail("…"))` is `m` present), and it fits any type. An `else` arm knows its
  condition false, and the code after a binding whose arm only fails knows what that arm ruled
  out (`y = m != null ? m : fail("…")` proves `m` present below). The run fails with the message
  exactly as the statement `fail("…")` does. Under 4, `ERROR` inside an expression stays
  `MOV_FUNCTION_UNKNOWN`.
- **`sort` by a function key**: `sort(xs, (r) => Text.lower(r.name), { order: "desc" })`. The
  function runs once per member with the member bound to its parameter, so a name inside it is
  never a field read in the member's scope, and an outer variable can never hide a field. The sort
  is stable and a missing key sorts last whichever the order, as `SORT` did. A key that answers a
  record or a value with named parts is refused (`MOV_SORT_NEEDS_KEY`), one that answers several
  values is `MOV_ORDER_KEY_MULTI`, and the one setting is `order` (`MOV_COLLECTION_OP_CONFIG`
  otherwise). The upgrade rewrites ``SORT(xs, `field`)`` to `sort(xs, (r) => r.field)`; the fix
  is marked safe only where no variable named `field` (or `r`) is in scope, because the old key
  read such a variable first.
- **A closure is not data** (`MOV_CLOSURE_NOT_DATA`). A closure lives in a variable (`g = label`,
  a call that answers one), in a parameter, or is passed as an argument to a parameter that takes
  one (`MAP(xs, (x) => …)`, `race(a, b)`, `all(a, b)`, a closure-typed parameter). It is never an
  operand of a value expression: `IF … THEN a ELSE b END` or `COALESCE(a, b)` choosing between
  closures, a comparison, interpolation, arithmetic, `NOT`/`AND`/`OR`, a condition, or a built-in's
  argument that is not its function. Refused: a closure as a list's element, a record or map's value (`{ g: label }`), a field
  written, a spread, a `MAP` whose function returns one, `GROUPBY` or `KEYBY` over closures, a
  `race` or `all` arm that returns one, and a type whose list element or record key is a closure
  (`<() => <text>>[]`, `<{ run: <() => <text>> }>`). There are no methods: a dot on a record or
  map always reads a field, and `box.g()` is `MOV_FUNCTION_UNKNOWN`, as `o.nope()` is. Under 4 a
  closure is no value at all, and a closure written in a list stays `MOV_EXPR_CLOSURE_POSITION`.
- **A value that is a closure is called**: a bound closure (`g = () => …` then `g()`), a function
  declared with a name read as a value (`g = made`, `() => made`, `return made`), a closure a call
  returns, or a closure-typed parameter. The call's type is what the closure returns, records
  included, so the record-in-data rules see a record it hands back. A value that may not be a closure, or whose type nothing shows, is refused where
  it is called (`MOV_CALL_NOT_MOVEMENT`). A body that is one call, `(f) => f()`, returns the call:
  a callee that waits parks the run, and one that returns nothing makes the closure return
  nothing. A body that is a combinator, `() => all(f, g)`, returns its answer.
- **A closure's type is written `<(params) => <return>>`**, TypeScript's function type:
  `handler: <(c: <Company>) => <text>>`, or a declared return. A closure-typed parameter is called.
  A closure fits the type with contravariant parameters (fewer is fine) and covariant returns
  (`MOV_CALL_ARG_TYPE` otherwise), and one written in place is an argument, its parameters typed by
  the type. Under 4 it does not parse.
- Adapter protocol: a type's describe may declare `deletable: true` (optional; absent means no).
  Attio, Affinity, Airtable, Evertrace (not signals), the knowledge graph and Valuations declare it
  where they delete. No protocol version bump: the field is additive, but under language version
  5 a remote adapter that does not declare it has every `delete` refused.
- The knowledge graph's `Resources` edge is walked by its name on every version
  (`c-[f:Resources]-> { … f.URL … }`), its landing typed with `Name`, `URL` and `Type`. The
  adapter matches it by its reserved address, so a team's ontology edge named `Resources` stays
  the ontology's.

- `-[f:_resources]->` reads off a record an extraction call found (`extract`, `extractOne`), and
  off its nested records: the content the call read, a FILE resource per file and a TEXT one per
  text. Before, the checker refused it. A paused run keeps them (park state: a `nodePosition` may
  carry `resources`).
- A built-in call on a line by itself (`Text.upper(x)`) parses, and the checker reports it as a
  value nothing reads, instead of a parse error.
- A node declared or written inline with a field or nested node named `__proto__` checks: the
  TypeScript checker threw on it.

### Language version 5, Dancing Wren: where it runs, and pauses

- **A run's engine is its pinned language version, with no fallback.** Version 5 and later run on
  the Rust engine, 1 to 4 on the TypeScript engine. The Rust engine refuses a run pinned below 5
  by name (`language_version_runs_on_typescript`) before it asks anything, and the TypeScript
  engine no longer runs version 5.
- **The checker is the one gate.** The Rust engine no longer screens a program before it runs
  (admission is gone). A construct it does not run fails the run where it is met
  (`MOVENG_UNSUPPORTED`, naming the reason), possibly after earlier writes; a checked program that
  reaches one is a checker or engine bug, and a test runs every version 5 program in the repository
  to catch it.
- A parked state the Rust engine cannot read fails its resume, naming why. A version 5 run the
  TypeScript engine parked (under the old emergency switch) cannot resume and fails saying so; a
  version 4 run a Rust park left resumes on the TypeScript engine.
- The Rust engine runs an extraction call's written `model` when the run carries no model list (a
  custom embedder), instead of refusing it: the checker held the model to nothing, so the host's
  model call answers for it.
- A host in any process zone runs version 5 alike: a date-time with no offset is UTC, so the shim
  sends no zone, and a process under a zone `Intl` cannot name (`TZ=GMT+3`) no longer fails its runs.
- **A paused version 5 run resumes on the library text it paused with.** Before, a resumed run read the libraries it imports from the team's saved files as they were at the resume, so an edit while it waited reached the rest of the run (code already parked kept its own copy). Now the pause pins every library the run linked, and the whole resumed run reads those texts. The movement's own text was already pinned to its version. Versions 1–4 are unchanged.
- **Park state contract version 2** (docs/contracts/park-state.md), written and read only by the Rust engine (language version 5 on). A paused run keeps all of its run state as before; code (a closure, a kept walk, a body-local node declaration, a run-time arm) is named by its place in the pinned program instead of carried as its syntax tree, and a collection op by its span. The TypeScript engine (versions 1–4) writes and reads version 1, and refuses a version 2 state by name. No version 2 state predates this (version 5 is unreleased).
- **Library texts a pause pins are kept once, by hash.** Self-hosted Postgres gains `automations.park_library_source` (migration `20261016_120000_park_library_source`); `lf` gains a `park_library_source` table in its state file. An embedder may serve the new optional host family `park.sources` (`save`, `load`); without it, a pause carries each library's text itself.
- `lf` refuses a project, or a parked run, pinned below version 5, saying to run `lf upgrade`.
- Self-hosting: `MOVEMENT_ENGINE`, `MOVEMENT_ENGINE_FALLBACK`, `MOVEMENT_ENGINE_DRY_RUN_EVERY` and
  `MOVEMENT_ENGINE_V5_ON_TS` are retired, and boot refuses any of them set. The admission dry run,
  its daily roll-up and `pnpm engine:refusals` are gone. `GET /api/v1/system/engine-stats` answers
  only the Rust segments' counters.
- Self-hosting: the `trigger_run.engine_reason` column is dropped (it was always null), by an
  ordinary migration operators run normally; the operator run views no longer carry
  `engineReason`. `engine` stays.
- For embedders: `movement.wasm` no longer exports `eval_expression`, and `movement-lang` no longer
  exports `callEvalExpression`.
- **The Rust engine runs forms it used to refuse as unsupported:**
  - a walk off a name holding a value starts from the records it holds: one record is itself, a
    list is each of its records, and anything else adds nothing to walk from (so a walk off a value
    that found nothing counts 0, and `exists` is false);
  - a walk from a callback inside an expression (`count(cb-[k:Called]->)`), reading the calls
    recorded so far, as a block over the callback does;
  - an `await` on an edge of a record the run read rather than wrote (the event, a walk's landing,
    or one record a value holds), asked of that record's system by its own id;
  - a kept (`lazy`) walk read as a bare value (`count(people)`): the records it lands on at that
    read, across a pause too;
  - the event read as a bare value (`coalesce(msg, r)`): the record that fired the run.
- **Endings that depend on what the system answers are run failures** (`MOVENG_RUNTIME`), not
  refusals by construct: an `await` on a system that cannot be awaited, or on a value holding
  nothing; an integration function such as `DOMAIN_OF()` written to a field whose system does not
  offer it; a collection op over a value that read as empty.
- **A host answer of the wrong shape ends the run with a coded runtime error** naming the host call
  and what was wrong (for example "the host's lookup.resolveActingUser answered something
  malformed: expected the principal's `id` as text, got nothing"). Before, the run ended with a raw
  JavaScript error. Covered: the acting user, a plugin's result (a `records` list must hold
  objects), a callback's calls, an awaitable adapter's resolution, a refetched record, and a file
  reader's `unreadable` reason.
- A paused run whose saved state names code the program does not hold (or a library it does not
  link) fails its resume up front, before anything runs (`resume_state_code_does_not_read`).
  Before, it failed partway through.
- A run whose host names a function taking a value as its entry fails saying the function is a
  callee, no longer that the checker should have caught it.
- The `unreproduced: true` marker beside the Rust engine's own refusals is gone: nothing read it.
  Such a refusal still ends the run as `MOVENG_UNSUPPORTED`, never forgiven by `onError`.
- The dev loop's scripts and fixtures that ship movement source (`pnpm dev:whatsapp setup`,
  `dev:airtable`, `dev:dealroom`, `dev:granola`, `dev:telegram`, `dev:gmail`, `dev:evertrace`, the
  `verify_*` probes, the `.mvt` fixtures) are written in the version 5 spelling.

### Self-hosting: the bundled object store is SeaweedFS (action needed if you used the bundled MinIO)

- **The compose bundle's object store is now [SeaweedFS](https://github.com/seaweedfs/seaweedfs)
  (`chrislusf/seaweedfs:4.48`, Apache-2.0), not MinIO.** Why: MinIO no longer publishes container
  images, so every pull of `minio/minio` — including the tag the bundle pinned — is refused, and a
  fresh installation could not start its file store. The service is `objectstore` on a new volume,
  `objectstoredata`; its profile is `objectstore`, and `minio` in `COMPOSE_PROFILES` still starts it.
  Setting `AWS_S3_ENDPOINT` parks it exactly as before. Nothing changes for an installation that
  names its own object store.
- **If your installation used the bundled MinIO, its files stay in the `miniodata` volume and the
  upgraded installation does not see them until you act.** Nothing deletes that volume (the compose
  file no longer names it, so not even `down -v` reaches it). Two safe options, both through the new
  `deploy/legacy-minio.yml` override, which runs your old MinIO from the image already on your
  machine: **(a)** keep MinIO as your own store — add the override to `COMPOSE_FILE` and point
  `AWS_S3_ENDPOINT=http://minio:9000` and the other `AWS_*` values at it; or **(b)** copy the bucket
  into SeaweedFS once — `docker compose -f docker-compose.yml -f legacy-minio.yml run --rm
  copy-from-minio` (rclone copy + check, keys unchanged, MinIO only read) — then remove the old
  volume by hand when you are satisfied. The exact steps are in deploy/SELF_HOSTING.md, "Upgrading
  from the bundled MinIO".
- **`./up.sh` now refuses to start** when the bundled store is in use, `<project>_miniodata` exists
  and `<project>_objectstoredata` does not, naming the two paths above; `--fresh-objectstore` (or
  `LF_FRESH_OBJECTSTORE=1`) is the explicit opt-in to an empty store. A bare `docker compose up`
  is not blocked (containers cannot see host volumes) but logs a WARNING when the config volume
  holds `minio_password`. The copy's check is `rclone check --one-way --size-only`.
- The bundled store's credential is a new file in the config volume, `objectstore_password`;
  `minio_password` is left where it is for option (a) and the copy.

### lfr-llm

- **The Rust `lf` calls models.** `lf-host` serves the engine's `ai(...)` and extraction model
  requests on the `anthropic` credential in the secrets file (`api_key`, and `base_url` for another
  endpoint speaking the Messages API; `https://` endpoints work, so the default `api.anthropic.com`
  is reached directly). Each call is priced from the same table the TypeScript `lf` reads
  (`packages/movement-engine/lib/models/prices.json`) and charged to its run under `model:<name>`,
  to the microdollar the TypeScript `lf` charges; a model with no price warns once and counts as
  free. A reply cut off at the output ceiling is continued, one that spent the ceiling thinking is
  asked again one effort lower, and a failed request is retried with the TypeScript `lf`'s backoff,
  except that a 4xx other than 408, 409 and 429 is not retried. The identity judge is still
  declined, as in the TypeScript `lf`.

### Security

- WhatsApp deliveries to a subscription's own webhook address (`/api/public/webhook-sync/inbound_whatsapp/...`)
  are now checked the way Meta signs them: the `X-Hub-Signature-256` header, keyed with
  `WHATSAPP_WEBHOOK_SECRET`, the same secret the main WhatsApp address uses. A missing or wrong
  signature, or no `WHATSAPP_WEBHOOK_SECRET` set at all, gets a 401 and nothing is delivered. Set
  `WHATSAPP_WEBHOOK_SECRET` if you point Meta at a subscription address. The main WhatsApp address
  also now answers a signed delivery for some other Meta product with 200 instead of leaving the
  request hanging.
- A credential is never a value, on every language version (`MOV_CREDENTIAL_NOT_A_VALUE`). Its name
  is allowed only as the `credentials:` argument where an integration is set up; the host resolves
  it there. Every other use is refused when you save: bound to a name, read with a dot, put in a
  string or a prompt, compared (with a null test too), passed to a function or a plugin, returned,
  or written into a field. Why: it is a security boundary, and every such use already failed at
  run time. The engine also stops answering a null test on a credential without reading it.
  `MOVEMENT_ENGINE=rust` does the same. The Rust engine also no longer hands out the name of the
  credential an integration was set up with, should an integration ever be held as a value.

### Changed

- The API's WebAssembly artifact (`movement.wasm`) is 1,271,541 bytes gzipped, down from
  1,527,856: the Rust engine runs only version 5 and later, so what it kept to answer as the
  TypeScript engine does is gone (admission, the expression-evaluation export, syntax trees in
  parked state). That is under CI's failure line of 1,572,864 bytes (1.5 MiB) by 301,323 bytes.
  The browser's parser artifact (`movement_parser.wasm`) is 362,824 bytes gzipped.
- **A program that runs on the Rust engine is checked by the Rust checker.** Every run on the Rust
  engine (an automation pinned to version 5 or later, any run under `MOVEMENT_ENGINE=rust`, every
  `lf` run, and their resumes) is checked inside the engine, with no `check.program` request to the
  host; saving, validating, upgrading and the deploy check of a movement pinned to version 5 or
  later use the Rust checker too, and so does `lf check`, so an author sees exactly the diagnostics
  the run enforces. Versions 1 to 4 keep the TypeScript checker, as do the editor's live
  diagnostics and completions for now. The two checkers give the same diagnostics, in the same
  order, on the whole versions 1 to 5 corpus. Nothing to set.
- **An automation runs on the engine its language version runs on.** `MOVEMENT_ENGINE` now defaults
  to `by-version` (was `ts`): an automation pinned to version 5 runs on the Rust engine, one pinned
  to 1 to 4 on the TypeScript engine, as before. A version-5 run the Rust engine refuses fails with
  the reason rather than quietly running on TypeScript. A run keeps its engine for its whole life:
  a parked run resumes on the engine its row's `engine` names. `MOVEMENT_ENGINE_V5_ON_TS` (new,
  optional, `false`) is the emergency switch: `true` runs new version-5 runs on the TypeScript
  engine (a run the Rust engine parked still resumes there). Why: version 5 is the Rust engine's
  language, and the TypeScript engine goes once nothing is pinned below 5. `rust` and `ts` still
  force one engine for every version, for testing. Boot now refuses `MOVEMENT_ENGINE_FALLBACK` set
  beside anything but `MOVEMENT_ENGINE=rust`, and the switch beside `rust` or `ts`. The admission
  dry run now counts only version-5 runs the TypeScript engine runs (every run under `ts`).
  Version-5 runs parked before this release were recorded as engine `ts` and finish on the
  TypeScript engine, so operators will see some version-5 runs on TypeScript after the upgrade.
  A version 1 to 4 run always resumes on TypeScript, which reads a Rust engine's parks.
- `MOVEMENT_ENGINE=rust` speaks language version 5 as the TypeScript engine does: a `_resources`
  walk off a system's record fails with the same error under 5 (versions 1 to 4 read it as before),
  the knowledge graph's `Resources` edge is walked by its reserved address on every version, and a
  catalog that declares a type `deletable` or an edge `resources` loads in the Rust engine. It runs
  version 5's `all(f, g, { concurrency, onError })` and `race(f, g)` whole, with the same parks and
  traces as the TypeScript engine: `concurrency` bounds how many arms run at once (an arm that waits
  frees its place), and `onError` `warn` or `ignore` leaves a failing arm's slot null, before or
  after a wait.
- `MOVEMENT_ENGINE_FALLBACK` (new, optional): `ts`, the default, runs on the TypeScript engine a run
  `MOVEMENT_ENGINE=rust` sends to Rust and Rust refuses, as before; `none` fails that run with the
  refusal's reason instead, and needs `MOVEMENT_ENGINE=rust` (boot refuses it otherwise). Under
  `none` a resume that answers a question (`resume_answer`) or defers a race's settlement
  (`resume_defers_race_settlement`) fails too, so set it only once the refusals report is empty,
  resume reasons included. Every automation run's row now records `engine` (`ts` or `rust`, for its
  latest segment) and `engine_reason` (the first reason the Rust engine's admission gave for not
  running it, `admitted` when it would take it or ran it, `shim_fault` when the Rust engine faulted
  in the shim, or `ended_at_check` when the run failed its check before either engine ran it,
  neither of which is an admission reason; empty when the dry run was skipped or faulted), shown in
  the operator run views; a deploy applies the new columns, null on earlier runs.
- `MOVEMENT_ENGINE=rust` runs more automations whole instead of handing them to the TypeScript
  engine: `@user_*` and `@actor_*` keys, an integration's field functions, `AI()`, `FILE()` and
  `READ()`, `IS <Declaration>` of a system's record, a records-output plugin's call and every plugin
  argument form, closures called by name, the extraction call (`extract(…)`, `extractOne(…)`), calls
  written inside an expression (a closure's, a plugin's, an extraction's), `ONLY` of any expression,
  `write m.k { … }`, collection ops with `concurrency`, and the file scope as the TypeScript reads
  it. The deployment's `EXTRACTION_TIERS` now reaches the Rust engine too, as run input, so a tier's
  model and effort are the same on both engines. New refusal reasons that can appear in a run's
  `engine_reason`: `nested_movement_call`, `nested_call_form`, `extract_call_shape`,
  `extract_call_settings`. Nothing to set.
- An extraction call's `model` is held at run time to the models this deployment reaches, the list
  the editor and the save already check it against, on both engines. A run whose saved catalog
  carried no model list could name a model the code knows but this deployment has no credentials
  for, pass, and fail at the provider; it now fails before the call, naming the models this
  deployment reaches. Nothing to set.
- A parked run's reason is no longer limited to a fixed list at the database: the core keeps
  `timer`, `await` and `limit`, and a unit (no unit writes its own reason yet; `ask` was a legacy
  value) may park under any other non-empty reason. The column loses its default of `ask` (migration
  `park_reason_unit_owned`). Rows already parked as `ask` are untouched. Nothing to do beyond the
  normal migrate step.
- Automations background work (cron, polls, timer resumes, inbound dispatch, await wakes,
  housekeeping) now runs from the `automations.work` table through one `drain` worker. Deployments
  may run it as an in-process loop (default) or tick it externally
  (`AUTOMATIONS_DRAIN_MODE=external` + `POST /api/v1/system/automations/drain`, body capped at
  `limit` 100 and `maxPasses` 50). The boot-time orphan sweep is replaced by lease expiry plus a
  sweep every 30 seconds that fails a run whose process died mid-step, with its inbound event.
  Events within one inbound delivery may now run concurrently or out of order. In external mode only
  the tick drains; a door enqueues without draining. Each tick records the drain's pulse on
  `/healthz/workers`, and the boot log names the drain mode.
- Automations may run as several instances at once, in either drain mode. The automations advisory
  lock is gone: every entry into a run (its first firing, a wake, a callback body, a timer, an
  operator's resume or abort) holds that run's own lease, a row lease on `trigger_run` (new columns
  `lease_owner`, `lease_until`, `lease_token`; migration `per-run-lease`), so two instances never
  step one run at once. A lease lapses a minute after its holder stops renewing it. A run another
  instance is stepping is retried rather than failed: a wake looks again two seconds later, two
  seconds more each time it finds the run busy (at most thirty), without counting as a failed
  attempt, a timer looks again five seconds later, a callback tap is recorded and answered `202` and
  its body runs from a queued `fire_callback` work row once the run is free, and resuming a paused
  run answers `409` (tRPC `CONFLICT`) to be retried. Every recorded tap writes its body's
  `fire_callback` row in the same transaction as the call, so a failure after a tap is recorded can
  no longer lose its body; a tap whose row cannot be written is not recorded, and the door's error
  may be retried. A body is marked as started before it runs, so it runs at most once: a crash part
  way through leaves that body incomplete rather than running its writes twice. A call is seen by
  `cb-[:Called]->`, and resolves an `await` on it, only once its body has started, so the awaiting
  branch never runs ahead of the body. Aborting a parked run while another instance resumes it
  stamps the cancel for that resume to settle; the periodic sweep settles a stamp that resume
  missed, whatever the run is parked on (it used to cover timer parks only). The external drain tick
  (`POST /api/v1/system/automations/drain`) answers on any instance and ticks may overlap; the `503
  not_lock_holder` answer is gone. The drain result gains `deferred`: rows released for a later
  retry because their run was busy. A segment that loses its run lease (it could not renew it within
  a minute) stops at its next statement, recording and settling nothing, since another instance may
  hold the run; the statement it was in has already run, so its effects can land twice when the new
  holder runs it again. A segment checks its lease again before it settles anything, so one whose
  lease lapsed during its last statement settles nothing either. Its lease fences its writes to the
  run's parked state: once another instance holds the run, the stopped segment can no longer write a
  park row, finish or drop a leaf, clear the run's parked rows and joins, or set the run's status
  (parked, or its terminal status). A lost lease is never forgiven by a collection op's `onError`. A
  first firing stopped this way notes why on its run for the orphan sweep; run status reads (REST
  `run-status`, `listRuns`, `inspectRun`, the run views) report that note as the failure reason only
  once the run has failed. A `parked_run` leaf being resumed is now `resuming`; one left so by a
  dead instance is parked again once its lease lapses. The other units' loops still take their lock,
  so they still run on one instance.
- The five-second await poll is gone. Answering or cancelling a question now wakes the run waiting
  on it directly, through a queued wake that survives a restart. A sweep every 30 seconds wakes runs
  still parked on a closed question whose wake was lost. A fired callback also queues a wake 30
  seconds out, so a run waiting on it still resumes if the process dies before its normal wake. A
  composed deployment that never registers its in-process ask notifier logs an error on each answer,
  and runs waiting on answered questions then resume only through that 30-second sweep. Leftover
  rows of the retired `await_resume_sweep` work kind are deleted at boot.
- Remote adapters speak adapter protocol 2. Breaking for anyone who built one: requests carry
  `protocolVersion: "2"` and a server answers its `manifest` with `protocolVersion: 2`; installing
  asks the server and refuses anything older. Names on the wire are the natural display names.
  Params are validated, and a mismatch answers `bad_request` naming the path. A remote adapter can
  now make an automation wait on its system (`resolveAwait`, `wakeKeys`), push to two new doors with
  its install's own secret (`POST /api/public/adapter/<type>/emit` for new events, `/wake` to resume
  waiting runs; the optional `x-listen-fire-team` header picks the team when one secret serves
  several), page large collections (`iterateRelatedPage`), and move files by URL. A remote's webhook
  subscription must return a secret, and deliveries are signed in `x-listen-fire-signature`. The
  contract is [`docs/adapter-protocol.md`](docs/adapter-protocol.md); the dev loop's fake CRM is the
  reference adapter.
- Identity writes are now serialised across runs, not only within one. Two runs, in one process or
  several, no longer both create the same record. An identity write (`unique by`) takes a Postgres
  advisory lock on its record type in the team (one system, one record type), held for that write's
  find-then-create and released after it. The cost: identity writes to one record type in a team run
  one at a time across all runs. Updates, deletes, links and bound writes lock their own record,
  edge or binding the same way. A write waits up to `MOVEMENT_WRITE_LOCK_TIMEOUT_MS` (new, optional,
  default 60000) for another run's lock, then fails the step with `write lock timeout: <name>`; two
  runs that each hold what the other wants fail this way rather than hang. Each running segment that
  writes holds one database connection of its own for its locks, outside the shared pool, so size
  `max_connections` for one per in-flight segment (see "Automations" in `deploy/SELF_HOSTING.md`).
  Test runs lock in memory, so they never wait on a live firing.
- A resumed run whose adapter has been uninstalled, or whose credential is gone or now serves
  another system, fails naming the instance (`instance <system>(credentials: <name>) is not in the
  catalog snapshot`).
- For embedders: the movement engine reaches everything outside the program through one
  `EngineHost`: adapters, model calls, parking (with record bindings), the trace, cancellation,
  files, acting-user lookup and write locks. A run takes a `CatalogSnapshot`, the team's catalog as
  plain JSON, rather than a live catalog. `makeTestHost` builds an in-memory host for tests. See
  [`docs/engine-host.md`](docs/engine-host.md).

- Remote adapters: every call Listen-Fire makes to a remote adapter now carries `x-listen-fire-team:
  <team id>`, so a server serving several teams knows which install is calling. The push doors
  (`emit`, `wake`) refuse a body over 1 MB with 413 (the limit was 25 MB).
- A remote adapter may no longer take a slug that a built-in adapter answers to (its slug, trigger
  kinds or aliases, in any casing), nor `callback` or `ask`. Installing one is refused, the push
  doors answer 401 for it, and the webhook door never routes to it. An existing install with such a
  slug was already shadowed by the built-in at resolution; it now also stops receiving pushes.
- The webhook door queues a delivery's await wakes before it answers 200. When the adapter's wake
  keys cannot be read, or their wakes cannot be queued, the door answers 500 after the delivery's
  events are receipted and queued, so the sender's retry re-attempts the wakes without running the
  events twice. It used to log the failure and answer 200, losing the wakes.
- For embedders: `EngineHost.park` gains `wake({ segmentId, adapterType, correlationKey })`, and
  `ParkSink.commitAwaitPark` no longer takes a `resolvesNow` closure. The engine re-checks an await
  itself once the park is durable and calls `park.wake` when it already resolved, so every host call
  carries plain data.
- For embedders: the engine host boundary is JSON-complete. Every method of every `EngineHost`
  family takes one JSON request and answers one awaited JSON answer, and
  [`docs/engine-host.md`](docs/engine-host.md) is now the frozen contract, method by method (shapes,
  errors, idempotency, what the host persists, which families are optional). A test round-trips
  every method through JSON and holds the method set to the document. By family:
  - `segment`: new. `open({ runId?, teamId, languageVersion })` answers `{ segmentId }`; `close({
    segmentId })` answers what the segment's adapter calls spent.
  - `adapters`: the engine holds no live adapter. `resolve` answers the instance as data and an
    opaque id; `call({ segmentId, instance, method, args })` answers `{ result }` or `{ error }`. An
    adapter failure carries its `name` and a `detail` (`{ status?, code? }`), and the host logs the
    original at warn. `resolveFileRef` is not callable: bytes stay on the host. Credential ids are
    run input (`credentialIds`).
  - `llm` and `files.resolveFileText`: every priced call takes the run's `budget` and answers its
    `cost`, or a `budget` refusal as data. `arbitrateEntities` answers `{ index, judgeUnavailable?
    }` in place of a callback. A plugin's arguments, output and pricing come from the catalog
    snapshot.
  - `park`: a timer's `wakeAt` and a callback's `expiresAt` are ISO 8601 strings.
  - `control`: `suspendWhen` is gone (a run takes `suspendAt` addresses as input), and the cancel
    gate's reason no longer crosses.
  - `files`: `resolveFile` is gone (imports resolve from the snapshot); files cross as descriptors
    only.
  - `lookup`: `resolveActingUser` names the source instance and the event; the host asks the source
    for actor candidates itself.
  - `locks`: `acquire({ segmentId, names })` answers a token; `release({ segmentId, token })`.
  - `trace`: new. `append({ segmentId, entries })` as the run goes.
  - `makeTestHost` and `makeFakeParkSink` moved to `movement_engine/test_host.ts`.
  - Every call names its segment: `segmentId` is on every request but `segment.open`'s
    (`control.cancel.cancelled({ segmentId })`, `park.callbacks.calls({ segmentId, callbackId })`),
    and the host answers each for the run and team the segment was opened for, so `teamId` is gone
    from `adapters.resolve`, `park.wake`, `park.bindings` and `lookup.resolveActingUser`.
    `adapters.resolve` answers one instance per resolution (system, credential, construction args,
    rehearsal) within a segment, and refuses a segment that is not open. `makeTestHost`'s default
    `park.wake` records each wake with the segment's team.
- For embedders: the five contracts the movement core speaks are written down under
  [`docs/contracts/`](docs/contracts/README.md), each with an integer version of its own and an
  index of what this release supports. The engine host contract moved there as `host-families.md`,
  and the adapter protocol as `adapter-protocol.md`. Two of them now carry their version on the
  wire, and an unsupported version is refused, naming the contract, the version and the supported
  set:
  - The catalog snapshot carries `contractVersion` (version 1). Both readers refuse another version;
    a snapshot without one reads as version 1.
  - When the web app and the API deploy separately, deploy the web app first. A browser still
    running an older bundle has a strict catalog reader that refuses a snapshot carrying
    `contractVersion`, so its editor cannot check until the page is reloaded.
  - `segment.open` carries `hostFamiliesVersion` (version 1). Both of this repository's hosts refuse
    an open under another version, or under none, before opening anything. Breaking for an
    embedder's host: it receives the new field.
  - `lookup.resolveActingUser` answers a principal, `{ principal: { id, display? }, email? }`, in
    place of a team user `{ id, email, name? }`. `@user_id` reads the principal's id, `@user_name`
    its display, and `@user_email` the email, which only a host that has one supplies; without it
    `@user_email` reads as absent. Saved automations are unchanged: this repository's host supplies
    all three as before.
- For embedders: two conformance kits. The host kit is every distinct run of the engine's v1 and v2
  test corpora, recorded at the host boundary (input, each request and its answer, the result) and
  replayable against any engine and host; ours replay on the TypeScript engine, the Rust engine and
  over an HTTP host double. The language kit replays a checks corpus against the checker: `pnpm
  language:conformance <checks.json>`. See "Conformance kits" in
  [`docs/contracts/README.md`](docs/contracts/README.md).
- For embedders: our checks corpus is no longer a file in the repository. The pin holds each
  program's hash, not its text, so `pnpm checks:corpus` in `packages/movement-lang` harvests the
  texts from the tests and writes the corpus to `target/checks/checks.json`; replay that file. The
  corpus format, and replaying your own, are unchanged.
- For embedders: an engine host must serve `clock.now` and `ids.mint`. They are required families of
  host families version 1: the engine reads no wall clock and mints no random id of its own, and a
  host that lacks either is refused before `segment.open`, naming the missing methods. See
  [`docs/contracts/host-families.md`](docs/contracts/host-families.md).
- For adapter vendors: `pnpm adapter:conformance --url <server> --auth bearer|secret` checks a
  remote adapter server against adapter protocol 2 without a Listen-Fire stack or a database. It
  prints `PASS`, `FAIL` or `SKIP` per check and exits 1 on any `FAIL`. See "Build your first
  adapter" in [`docs/contracts/adapter-protocol.md`](docs/contracts/adapter-protocol.md).

- The movement parser is implemented in Rust and loaded as WebAssembly; the TypeScript grammar is
  removed. Browser callers await `initParser()` before parsing. Two parses differ, under every
  language version:
  - Nesting deeper than 128 levels is refused with "nesting too deep". Statements and expressions
    are bounded separately: statements count their own levels, and each expression counts its own
    from zero. It used to be accepted. Much deeper nesting would overflow the WebAssembly parser's
    stack; real automations nest a few levels.
  - An expression error naming an unrecognised character outside the Basic Multilingual Plane (an
    emoji, say) now quotes the whole character. It used to quote half of it.

- Movement-language expression lowering is Rust; the TypeScript lowering is deleted.
- The checker's catalog and type-model core is Rust, behind `catalog_query`, held to the TypeScript
  by a differential.
- Added a checker conformance corpus (`checks.json` and snapshots) that pins diagnostics across the
  checker port.
- `constructor`-style keys (`constructor`, `__proto__`) no longer lower as properties.
- Chains over 1,024 members are refused ("chain too long"). A resource limit, not a language rule,
  so no language-version conditional (same precedent as the 128 nesting limit).
- Deep nesting is refused at the limits: 128 for parse, 2,048 for JSON reads, 256 for typed catalog
  reads. Resource limits, not language rules, so no language-version conditional.
- The movement engine has a second implementation, in Rust (`crates/movement-engine`), behind
  `MOVEMENT_ENGINE` (new, optional): `ts`, the default, runs every movement on the TypeScript engine
  as before; `rust` runs on the Rust engine every run it can run whole, and the rest on TypeScript.
  Any other value fails startup. Under `rust` it runs reads of the event and of values, bindings,
  `if`, `return`, the built-ins, writes (with `unique by`, a `WHERE` on the target, off a traversed
  record, in place on one), `match`, `link`, `unlink`, `delete`, node and graph literals, traversal
  blocks of one hop (nested, bound, with `WHERE`, `ORDER BY` and `LIMIT`), `sleep` with its resume,
  and a pause at the run's cost cap, the extraction keyword (`x = extract from […] { tree }`,
  without a tier: its model calls, `through` stages, fenced children, files and resources, heads
  over what it yielded) and a plugin's plain call (of a plugin declaring a value or a record),
  walks, folds (`FIRST`, `COUNT`, `SORT`, …), `EXISTS` and `IS` tests in an expression, a record
  named twice and `ERROR(…)`, and hands a run back before any effect when it needs more (a pause or
  a cost cap inside a block stays on TypeScript, which joins a fan-out's parked iterations). The
  Rust engine decides what it runs on its own parse of the program, before it touches anything, and
  a run it hands back costs no second check. Each run logs one line naming the engine that ran it
  and why (`movement engine: engine=rust|ts run=<id> reason=<reason|admitted>`), at info under
  `rust` and at debug under `ts`, and `GET /api/v1/system/engine-stats` (the `system` scope) answers
  the process's counts since it started: runs not admitted and declined by reason, runs routed and
  run whole, and the evaluator's. Both engines park in one format, so a run parked on one resumes on
  the other. Chunk 6A moved the conformance corpora's runs whole on the Rust engine (v1 and v2) from
  117 and 139 (109 and 126 replayed) in steps: file-level declarations and plugin imports 119 and
  141, extraction and plugin calls 223 and 268 (195 and 234 replayed), folds, `EXISTS`, `IS` and a
  record named twice 289 and 352 (256 and 313); admission walking only what the fired movement
  reaches, 290 and 353 (257 and 314). Before that, 69 and 75 before traversal blocks and the record
  verbs. Each later step is counted in the burn-down entry below. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, the Rust engine's admission walks only the movement a run fires and
  the movements it reaches, with the file's declarations and values. A helper movement nothing calls
  no longer sends its whole file to TypeScript. Admission also no longer stops at the first
  construct it does not run: a refusal names every reason it holds, and `GET
  /api/v1/system/engine-stats` gains `runs.allReasons` (runs not admitted, counted under every
  reason each holds) beside `runs.notAdmitted` (counted under the first). Which runs the Rust engine
  takes changes only by the helpers no longer walked: the corpora run one more run each whole on it.
- Under `MOVEMENT_ENGINE=rust`, the Rust engine now runs calls of the movements a program declares
  (as a statement, bound, returned, or as another call's argument; recursion refused before language
  version 3 and bounded by `MOVEMENT_MAX_CALL_DEPTH` from it, which the Rust engine reads once per
  segment where the TypeScript engine reads it per call) and the graphs a run builds: declared edges
  (`companies: <Company>`), writes, matches, position writes and links into a node's edge, block
  heads and expression reads (a field, `COUNT`, `EXISTS`) over one, traversal entries, `lazy`
  entries and `x = lazy …`, and `graph<Shape> { … }`. A source the Rust parser refuses goes on to
  the check, which fails it with its own parse error. Refusals it adds, each before anything is
  asked: `call_park` (an `await sleep` inside a called movement), `cost_cap_inside_call` (a capped
  run that could suspend inside a call) and `lazy_park` (a run that may park holding a lazy walk).
  The corpora now run 394 (v1) and 469 (v2) runs whole on it, the binding × consumer matrix's
  admitted cells included, and 312 and 379 recorded runs replay on it. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, the Rust engine now runs records held as values, as the TypeScript
  engine reads them: a walk read as a list of records, a record passed to or returned from a
  closure, fields an object lacks read off `Object.prototype`, records compared by identity, a dict
  made text through its own `toString` or `valueOf`. It also runs `MAP`, `FILTER`, `REDUCE`,
  `GROUPBY`, `KEYBY` and `MEMBERS` whose concurrency is 1, tuple writes, writes and links rooted at
  or spreading any record, and `EXISTS` over a value. The event no longer goes to TypeScript for
  holding such a dict. Mid-run, a record handed to a host request fails the run with
  `MOVENG_UNSUPPORTED` before the request is made. The corpora now run 1006 (v1) and 1309 (v2) runs
  whole on it, and 346 and 429 recorded runs replay on it. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, a program that could hand its host a record held as a value — inside
  a plugin's argument, a system write's field, an extraction's `from` text, a reading the Rust
  engine passes to the TypeScript one — now runs on the TypeScript engine from the start
  (`plugin_arg_record`, `write_field_record`, `extract_from_record`, `builtin_arg_record`; likewise
  `at_record_key` and `node_spread_record`), where it used to fail partway. A GROUPBY or KEYBY that
  files a record under the key `__proto__`, and event values shaped like the engine's own records,
  now read as on the TypeScript engine. A collection op's `onError: "warn"` or `"ignore"` no longer
  drops a member the Rust engine could not read; the run fails naming it. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, a text holding half of a surrogate pair (a host's JSON can carry one
  as a `\udXXX` escape; a cut through an emoji, `SPLIT(text, "")` or `TEXT.REGEX_EXTRACT` makes one)
  is held and read as on the TypeScript engine. A plugin's, a file reader's or a model's answer
  holding one used to fail the statement, and an extraction reply holding one was asked again; an
  event holding one, `SPLIT(text, "")` of an emoji and a match through one ran on the TypeScript
  engine; a cut through an emoji (a trace's sample, a source file bounded for the prompt) dropped
  the emoji where the TypeScript engine keeps its first half. Authors see no difference.
- Under `MOVEMENT_ENGINE=rust`, the Rust engine reads date text as the TypeScript engine's `Date`
  does: V8's parser, its ISO form and its legacy one (`March 12, 2026 9:30 PM`, `12/03/2026`, `Thu,
  12 Mar 2026 09:30:00 GMT+0530`, two-digit years, zone words, comments in parentheses), NaN where
  V8 gives NaN. `DATE`, `DATETIME`, `DATE.FORMAT`, `DATE.FORMAT_ISO` and a filter's `<`/`>` between
  two texts no longer go back to TypeScript. A date-time with no offset is read in the local zone,
  which is now a run input: the shim hands the engine its process's zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`, the zone `Date` reads in), checked against
  `Date`'s own wall clock first — under a `TZ` whose zone `Intl` cannot name as `Date` reads it
  (`GMT+3`, `UTC+3`; a `TZ` `Intl` names no zone for, such as `utc`, is read as `UTC` when `Date`
  agrees) the run and the expression stay on the TypeScript engine (`local_zone_unverified`) — and
  an embedder's run with none reads UTC (`localZone` in
  [`docs/contracts/host-families.md`](docs/contracts/host-families.md); optional, so the contract's
  version is unchanged).
- Under `MOVEMENT_ENGINE=rust`, the Rust engine retirement's burn-down (chunk 7A), as the
  conformance corpora count it. Each step's runs run whole on the Rust engine, all agreeing with
  TypeScript (v1 / v2, and v3 once its corpus arrived), with the recorded runs replayed on it (of
  443 / 542):
  - Task 1, admission walks only what the fired movement reaches and names every reason: 290 / 353
    (257 / 314 replayed).
  - Task 2, calls of declared movements and the graphs a run builds: 394 / 469 (312 / 379).
  - Task 3, records held as values and collection ops: 1,006 / 1,309 (346 / 429). These counts, and
    every count before Task 7's, include programs that only ever failed their check: the run-whole
    definition that excludes them arrived with Task 7.
  - Task 4, awaits, `parallel` and `race`, parks anywhere and every park state resumed: 1,060 /
    1,363 (392 / 475). The forward merge that brought the v3 corpus: 1,060 / 1,362 / 1,918.
  - Task 4b, data never read as an engine object; Task 4c, language version 4's four changed
    constructs; Task 5, the regex dialect, Unicode case mapping, mixed-key sorts and
    `Object.prototype` reply fields mirrored from V8 and zod; Task 5b, V8's date parser and the
    local zone as run input: the same 1,060 / 1,362 / 1,918.
  - Task 6, the rest of the burn-down (the entry above): 1,188 / 1,499 / 2,556.
  - Task 4d, a file is only what an envelope declares: 1,180 / 1,491 / 2,547 (the corpus cases that
    handed the engine a descriptor-shaped dict as a file are triaged).
  - Task 6b, admission reads the checker's types for parameters, calls and spreads: 1,174 / 1,485 /
    2,566, with 6 / 6 / 4 runs counted apart as failing mid-run by name (`MOVENG_UNSUPPORTED`), each
    a corpus case pinning that same failure on both engines. Its fix round's commit subject says
    "text coercions are values", which is not what it did: `MULTI(co)` written into a field
    (`write_field_record`) or handed to a value parameter (`call_arg_record`) stays refused.
  - Task 7, the counts made honest. A Rust-routed program is now checked before its segment opens,
    as the TypeScript route checks it, so a program that fails its check makes no host request on
    either engine and never reaches the Rust engine; such runs used to count as run whole. Of 1,193
    / 1,514 / 2,662 runs attempted, 1,023 / 1,251 / 2,152 run whole; 12 / 21 / 86 are refused at
    admission by name, 6 / 6 / 4 fail by name, 0 / 0 / 3 are declined, and 152 / 236 / 417 fail
    their check before a segment opens. The recorded runs replay 430 / 519, every run the Rust
    engine ran to an ending judged by its verdict. Nothing to set.
- CI's size warning for the API's WebAssembly artifact (`movement.wasm`) moves from 800 KiB to 1 MiB
  gzipped, and its failure line from 1 MiB to 1.5 MiB: it is 963 KiB (986,091 bytes) as chunk 7A
  ends, the readings of records held as values having first taken it past the old line. The
  browser's artifact is unchanged. It now crosses the 1 MiB warning at 1,171,349 bytes, still under
  the failure line: a paused run's closures, walks and local shapes are rebuilt on resume from the
  syntax tree saved with the pause rather than looked up by position, and reading that tree back
  takes about 100 KB. The Rust checker now ships inside it too (a run on the Rust engine is checked
  by it), which takes it to 1,494,633 bytes, still under the failure line.
- The browser now loads the parser's own WebAssembly artifact (`movement_parser.wasm`, 325 KB
  gzipped, a little over the earlier 323 KB because the parser reads text in the engine's in-band
  form, so a U+FDD0 or a lone surrogate half in a source crosses it exactly), not the API's
  (`movement.wasm`, parser and engine, 711 KB gzipped). The API artifact's size warning in CI moves
  from 600 KiB to 800 KiB gzipped (it still fails at 1 MiB): the Rust engine's traversal blocks,
  record verbs and wake-driven executor took it past the old line, and extraction, the next slice,
  adds more.
- A second deployment shape for automations' background work, push-tick (`deploy/SELF_HOSTING.md`,
  "Deployment shapes"). In `AUTOMATIONS_DRAIN_MODE=external`, `AUTOMATIONS_TICK_URLS` and
  `AUTOMATIONS_TICK_KEY` (new, optional, set together or not at all; half the pair fails boot) make
  each enqueue POST a drain tick to every URL, so a door's work starts without waiting for the
  scheduled tick. `node build/scripts/drain_once.js` (new) drains until idle and exits, for a
  scheduled job with no HTTP. Nothing changes for a deployment that sets none of them.
- On every language version, a binding, function or closure whose inferred type has more than
  10,000 distinct parts is refused (`MOV_TYPE_TOO_LARGE`); split the value into named parts or
  declare its shape. Why: a chain of closures, each returning a map of the last one's value, made
  saving an automation take minutes. The checker is now linear in a type's distinct parts, and this
  limit bounds what one program can cost to check. It is a safety limit, not a language rule: no
  program that reaches it ever checked in reasonable time.
- From language version 5, a dotted call of a function that is no built-in (`o.nope()`, `box.g()`) is
  `MOV_FUNCTION_UNKNOWN`. The engine runs `o.f(…)` as `f` in `o`'s scope, and outside a write field
  there was never such a function: the run always failed where it reached the call. Versions 1–4
  are unchanged, as are a built-in in a record's scope (`o.UPPER(name)`) and a write field's own function.
- The engine's unsupported-construct scan reads a movement as the language version it is pinned
  to, so a form version 5 reads differently is scanned as what it means under the pin.
- A closure written in a movement body holds the scope it was written in by reference, as a
  JavaScript closure does (and a file-level closure already did), rather than a copy of it. A wait
  writes each scope once and each closure as its code and the scope's number, so a parked state
  grows by a few hundred bytes per closure: 14 unused closures in one body park at 8 KB, where
  each copied every earlier one and the state doubled per closure (15 MB). Every language version,
  and a run parked before this resumes with its copies as it did. A parked run now sees what an
  unparked run sees: under version 4 and later, a `MAP` member that parks and returns closures
  which write an outer handle, run by `parallel`, ends with the handle all of them wrote (the outer
  read `"v2"`, as unparked), where it split the handle across the park and the outer read a stale
  `"one"`.
- A named function's declared return no longer hides what its body may hand back: under language
  versions 3 and 4, `function f(): <text> { return COALESCE(org, "x") }` is a call whose use in a
  graph entry, a spread, a written field or a plugin argument is refused at the use, as a closure's
  call is (a use that reaches data cannot hold a record, on every version). A call back into a
  function from its own body (declared recursion) carries nothing for that edge, so recursion is
  no call cycle. The declaration itself is refused only from version 5.
- Security: a Mailgun inbound attachment is fetched with the deployment's key only from an https
  storage URL under `MAILGUN_SENDING_DOMAIN` (`/v3/domains/<domain>/…` on a `mailgun.net` host);
  any other Mailgun URL is refused. Inbound-only deployments must now set `MAILGUN_SENDING_DOMAIN`
  to the domain of their route.
- Moving an automation up to language version 4 now warns (`MOV_HANDLE_READ_FOUND`, a move-up
  warning) on a read of a write handle's `url`. Under version 4 it reads the found record's url,
  where versions 1 to 3 read the link the write returned (null when the update returned none).
  The handle's own result-shape fields other than `url` (today only `externalId`) are exempt.
- A field or child node named `__proto__` in a node declaration or an extraction is refused
  (`MOV_SHAPE_FIELD_PROTO`), and so is a binding, parameter or alias named `__proto__`
  (`MOV_NAME_PROTO`), on every language version. Both used to validate but misbehaved at run time,
  because JavaScript reads that key as an object's prototype: the extracted record never held the
  field, a closure's parameter read as `{}`, and a parked binding was dropped so its resume
  failed. A bug fix, not a language version: an automation using one now fails its check; rename
  it.
- A map spread into a graph (`held = { k: r }` then `graph { ...held }`) that holds a record under
  any key, at any depth or in one arm of an operator, is refused where it is written
  (`MOV_GRAPH_SPREAD_RECORD`, with the path), on every language version. It used to validate from
  version 2 and fail the run at the spread. A bug fix, not a language version: write a field off
  the record, or write the record into the graph as an entry of its own (`k: r`). An unshaped
  spread whose keys nothing names (version 1's map literals) is refused as untyped alone; the
  record's refusal comes with the shape it asks for.
- A graph entry that is not one record or a list of them but may hold a record
  (`graph { a: COALESCE(r, "x") }`, an `IF` arm) is refused where it is written
  (`MOV_GRAPH_ENTRY_RECORD`, with the path), on every language version, on the same terms as a
  spread: it used to validate and the run stored the record as a field. `a: r` (an edge holding
  the record) is untouched.
- A call's value holds what any of the function's returns may hold, so a record or file a return
  hands back through `COALESCE`, `IF` or `MULTI` (`f = () => COALESCE(org, "x")`, or returns that
  disagree) is refused where the call's value goes, as the bound conditional is: a graph entry
  (`name: f()`), a spread, a written field, a plugin argument, an extraction input, a `MAP` or
  `REDUCE` over it. A named function's bound call on every version; a closure's call (and any call
  inside an expression) from version 3, where they run. It used to validate, and the engine handed
  its own record object onward. A bug fix, not a language version: return a field off the record.
  A declared return type that does not take what a return may hold (`(): <text> => COALESCE(org,
  "x")`) is `MOV_RETURN_TYPE` at the declaration from **version 5 (Dancing Wren)**: it ran on
  versions 3 and 4 while the call was unused or only compared, so there the declaration is clean
  and the call carries what the body may hold, refused where it reaches data.
- A `parallel` or `race` receipt holds what its arms return, as `[a(), b()]` does, so a record an
  arm hands back (a write handle, a found record) is refused where the receipt or a slot of it
  (`AT(r, 0)`) is written into a field, a graph entry, a plugin argument or an extraction input:
  inline closure arms, named closure arms and named movement arms alike, on every language
  version. It used to validate, and the engine wrote its own handle object into the field
  (`{"kind":"handle",…}`). A bug fix, not a language version: return a field off the record. A
  literal index reads its own slot (`AT(r, 1)` of a text arm is written; `graph { a: AT(r, 0) }` is
  an edge, as over `[a, "x"]`). Arms that return values leave the receipt plain data. A receipt
  whose every slot is a record is an edge list at a graph entry (`graph { a: r }`), as
  `graph { a: [made(), made()] }` is; one that mixes a record with a value stays refused, and the
  message offers the record slot (`a: AT(r, 0)`). A record slot of a parallel/race receipt written
  as a graph entry (`graph { a: AT(r, 0) }`, or `h = AT(r, 0)` then `graph { a: h }`) was stored as
  the engine's own object; it is now an edge to that record (both engines), on every version, as a
  bug fix under the no-record-inside-data rule, not a version change. On version 1, which does not
  type a call's value (the documented B4 gap), a receipt is stricter than the list literal
  `[made(), made()]`: it is refused where the literal is accepted, because accepting it leaks.
  Arms known where they are written are typed too: a name bound to a list of functions
  (`arms = [made, label]`), or to a `MAP` whose closure returns a closure
  (`MAP(xs, (n) => () => made())`), type the receipt by what those return. Arms known only at run
  time (a `FILTER` or concatenation of such lists, a list passed in or returned by a call) stay
  untyped, so a checked program can still hand a record through them.
- A union whose every member is a record (`COALESCE(a, b)` of two records, or a function returning
  one of two) is one record for the graph entry: `a: r` over it is an edge, as it is over one
  record, on every version. It was refused as a field holding a record. A union that mixes a record
  with a value is still refused.
- A closure's or function's returns are flattened and deduplicated, and the kinds of engine object
  a type holds are remembered per type, so a chain or fan of calls checks in linear time.
- A plugin argument the plugin declares a value type for (text, a file, …) takes no record or file
  that type does not hold, on every language version (`MOV_CALL_ARG_TYPE`, with the path): a file
  handed to a text argument (`tag(label: f)`, or one arm of a `COALESCE`), a file or record under a
  key or in a list of the value (`tag(label: { a: f })`, `ocr(doc: { a: f })`). Each used to
  validate, and the plugin was handed the engine's own description of the file or record. A bug
  fix, not a language version: pass the file's text (`READ(f)`), a field of the record, or the
  file itself to an argument that takes a file.
- A run's result (and the run records and views built from it) never carries a write record's
  `old` member (it only exists under language version 4), the engine's own handle for the record as
  found (its instance, adapter slug, credential name and full schema). `-[:@old]->` still reads it
  during the run.
- Redis is optional. The API connects to Redis only when `MESSAGE_QUEUE_REDIS_HOSTNAME` is set
  (the port still defaults to 6379); unset, nothing ever tries to connect, in every environment.
  Without it the runaway-loop guard counts in each API process's memory (exact for one instance;
  several instances each count only their own firings), the icon cache is off, and in-flight MCP
  OAuth state is not shared between instances. The bundled composition and the Render blueprint
  still name their Redis. The `localhost` default the API used outside production moved into the
  dev loop, which exports it for the Redis container it runs.

### Fixed

- A hop's alias read under 5 (`c.name` in `-[c:company WHERE c.name == "Acme"]->`) works over
  records the run already holds: an extraction's entities, nested ones too, a `node { … }` or
  `graph { … }` literal's entries and the records written onto a local node. Before, both engines
  failed the run with "edge-property reads outside a traversal WHERE", so these programs had no
  runnable version 5 spelling. A bare name there is the variable it names, as everywhere under 5.
- A hop's WHERE over an extraction's entities runs in a block head and an expression
  (`deals-[c:company WHERE …]-> { … }`, `Text.join(deals-[c:company WHERE …]->.name, ", ")`), on
  every language version. Before, only `exists` ran it; the others failed the run.
- `MOVEMENT_ENGINE=rust`: a file bound to a name such as `fields`, `body`, `head`, `position`, `op`,
  `mapping`, `closure`, `params`, `origin` or `handle` is a file again after a park and resume
  (before, it came back as a dict and `READ` of it failed). The host now finds a parked state's
  files by the park's structure, never by a member's name, so data shaped like a file (a JSON field,
  an adapter's answer) is never revived as one, whatever key it sits under.
- A graph literal spreading the event (`graph { ...msg }`) or a member of a record (`graph<S> {
  ...co.meta }`, `...msg.meta`) passed its check and then failed every run (MOVENG_UNSUPPORTED for
  the event, MOVENG_RUNTIME for a record's member). The event is now copied as any record is, and a
  record's member reads its field, on both engines.
- `MOVEMENT_ENGINE=rust` runs more automations whole instead of handing them to the TypeScript
  engine: a `match` over a tuple of paths, `IS <Declaration>` of a graph literal holding a system's
  records, a graph spread of the event or of a record's member, `refresh`, and a function (a
  library's too) returning its closure's call. Nothing to set.
- `MOVEMENT_ENGINE=rust` parks and resumes as the TypeScript engine now does: one write handle two
  names hold is written once and comes back as one, a library's node declaration or function is
  found again in its library, and a closure bound at a file's top level is in scope in that file's
  functions and parks by name. A state either engine parks resumes on the other.
- `IS <Declaration>` against a declaration a library writes, of a system's record, failed on
  `MOVEMENT_ENGINE=rust` naming the declaration as unknown; it now compares as on the TypeScript
  engine.
- An extraction's `through` stage naming a priced plugin imported under another name (`import {
  fetch_url as fetch } from plugins`, then `through [fetch(url: …)]`) escaped the run's cost cap:
  the engine looked the plugin up by the name the stage wrote, found no plugin of that name, and
  invoked it as unpriced, under that name. It is now looked up and invoked by the name it is
  registered under, so a run that has spent its cap stops before the plugin starts, and the plugin
  is fed the arguments it declares (its required and extraction-fed ones). A plain call (`page =
  fetch(url: …)`) was already priced by its registered name.
- A run parking on an await could miss a wake that arrived while it parked, and then wait forever.
  The park now writes the parked run before the correlation that points at it, so a wake in between
  finds both or neither. When the re-check after parking itself fails (the remote is down), the run
  stays parked without a wake and the failure is logged with the await's key; the adapter's own wake
  covers later landings.
- Engine: the interpretability scan honours the run's language pin. The save-time check of which
  constructs the engine can run now reads an automation under its pinned language version, not the
  current one, so it reports for a version 1 or 2 automation what the engine would refuse under that
  version. For example, a call to a function written in another letter case reaches the function
  only from version 3: under version 1 or 2 the check now reports it as an unsupported function
  call. The demand scan (which systems' schemas a run's check is given) also reads an automation
  under its pin, including a version 1 or 2 collection operation (`MAP`, `FILTER`, `REDUCE`, …),
  which demands what it read before.
- For embedders: the Rust engine's `eval_expression` refuses an envelope with no `languageVersion`,
  naming it. It used to read a missing version as the oldest behaviour. Pass the movement's pin.
- For embedders: `trace.append` now requires `wire: true`, with its entries on the eval wire. The
  Rust engine now also asks `ids.mint`, `llm.client.call`, `llm.transforms.invoke`,
  `files.resolveFileText` and `log.write`.
- `write v { … }`, where `v` is an `IF` or a `COALESCE` of two records with no one type, no longer
  reports the checker's own internal error (`MOV_INTERNAL_UNTYPED_BINDING`) on any language version.
  `v` is read as what it may hold, as `delete` and a graph entry read it: records alone are one
  record; one that may be absent, or a value among them, is `MOV_WRITE_POSITION_NOT_RECORD`.
  A write in place to one of several records (`write who { … }`) is held to every member on every
  version, so a field one member lacks is `MOV_WRITE_UNKNOWN_FIELD` and every write check applies to
  each.
- A run that names a credential for a remote adapter (`x(credentials: X)`) now fails when it is not
  the credential the adapter was installed with, saying the remote install serves only its own. It
  used to be ignored: two accounts on one remote adapter silently reached the install's account, so
  writes landed in the wrong workspace. Naming the install's own credential, or none, is unchanged.
  Per-run credentials for remote adapters are still to come.
- A `parallel` or `race` arm that names a closure written in the movement body (`f = () => { … }`
  then `parallel([f, g])` or `race([f, g])`) and waits inside it resumes. It used to fail "resume:
  no body for arm 0", because the resume looked an arm's name up only as a movement. It now finds
  the closure by its name in the scope around the combinator, as the run did, and its arm resumes
  with the scope it brought in. Every language version; a parked state is unchanged. `MOVEMENT_ENGINE=rust` resumes it the same way, and a scope cycle
  (a closure whose scope reaches back to itself) settles there as on the TypeScript engine.
- A movement that holds a written record (or a built node) and then waits inside a function it
  calls resumes again. Since the previous fix below, resuming it failed "the parked state refers to
  write handle(s) #0 that it never wrote", because the resume read the movement's own names from
  a copy that only pointed at the record. The resume now finds each record wherever the parked
  state wrote it. Every language version; a parked state written before is unchanged and resumes.
  `MOVEMENT_ENGINE=rust` resumes it the same way, and also resumes one whose name matches a part of
  the parked state's own layout (a record named `body`, `position` or `fields`, say).
- `MOVEMENT_ENGINE=rust` reads a `parallel` / `race` receipt's record slot as the TypeScript engine
  does (the record from language version 5, null before), and runs whole a value that may be a
  record or a value handed to a record parameter under versions 1 to 4 (`position_arg_record` no
  longer appears for it), ending as the TypeScript engine does.
- Two names for one written record stay one across a wait (`b = a`, `b = write a { … }`, or a
  closure that captured it). After resuming, an in-place `write a { … }` or `refresh a` used to
  leave `b` reading the record as it was before the wait; it now reads what `a` does, as a run that
  never waits always did. Every language version: a wait is not part of the language, so what a
  name reads must not depend on it. The same holds for the names a `parallel` / `race` arm or a
  fan-out iteration leaves when it finishes after a wait, and for a node held under two names
  there. A parked state that holds each record once is unchanged.
- A library's closure that waited before testing `x IS <Decl>` against the library's own
  declaration now resumes. The resume looked the declaration up in the root program, so it failed
  "cannot re-resolve code ref", or used the root's declaration of the same name. A parked node
  declaration or function now says which library it belongs to, and is found again there. Every
  language version: the run before the wait already read the library's, so nothing else changes.
  A run that was already waiting when this shipped resumes as before, since its parked state
  does not say which library: one whose library declaration is shadowed by a same-named
  declaration in the root program still reads the root's.
- A closure bound at a file's top level (`f = (n: <number>) => …`), in a library or the root
  program, is now in scope inside that file's functions. The run used to fail "'f' is not in
  scope". It holds its file's scope by reference, as a JavaScript closure holds its module's, so
  it also sees the file's later closures (`f = (n) => g(n) + 1` before `g = …`), and a wait
  stores it by name, so a parked state stays small however many a file declares. Every language
  version from 3, where a closure became callable; it always failed before, so nothing that ran
  changes.
- A record passed to a function another file exports is no longer refused when that file constructs
  the same system ("expects inbox.message, but this argument is inbox.message"). A system is its
  address (the adapter, the credential and the values of literal construction arguments), not
  the name a file binds it to, so two names, in one file or two, for the same system hold the
  same records; a different credential or literal is still a different system, and the refusal
  says which differs. A construction with an argument that is not a literal (`base: b`) stays a
  system of its own. Every language version.
- A Redis outage no longer stalls automations. The loop guard is meant to step aside when Redis is
  unreachable, but a dead Redis used to hang every trigger dispatch indefinitely. Connecting to
  Redis now gives up within seconds, and the guard lets runs through unchecked, pausing its
  counting for five seconds at a time until Redis is back.
- A file whose extracted text contains NUL characters (a PDF with glyphs its font map has no name
  for) no longer fails the run. The text is stored with each NUL replaced by a space, and a failure
  to store the extracted text as provenance is logged rather than failing the run.

### Security

- The Rust engine never takes data an automation reads (a webhook body, an adapter's answer, an
  answer to a question, a callback's fired values, a plugin's output) for one of the engine's own
  objects, whatever keys it carries. Before, a dict whose `kind` named an engine object (`lazyWalk`,
  `closure`, `instance`, `toString`, …) was read as that object, so a webhook body could make the
  run walk a system, or run expression text the body carried. Now such a dict is a plain dict on the
  Rust engine: its `kind` reads as text and a hop off it is refused as a hop off any value is. The
  TypeScript engine has the same fix (the entry below), so a run the Rust engine refuses at
  admission and hands to the TypeScript engine reads such data as data too. Not a language version:
  no construct's meaning changes, and a saved automation runs as it did unless its data impersonated
  an engine object.

- A file is read only where the envelope carrying it declares one, on both engines. Before, any
  value spelling a file's descriptor (`{ "__brand": "FileRef", "source": { … } }`) — a webhook
  body's field, a field answer, a knowledge-graph property, a remote adapter's answer anywhere in it
  — was taken for a live file: `READ`, `extract from [ … ]`, a plugin's fetched record and a write's
  file field read the bytes it named, which could be another team's stored document or any
  connection's file. Now the engine makes a file only at a field a system's schema types `file`, a
  resource's `fileRef`, a field a plugin's output declares a file, `FILE()`'s answer, and a parked
  file the park says is one. The same shape anywhere else is plain data: its keys read and print
  (`TEXT.SERIALISE`), an extraction reads it as its JSON text, `READ` refuses it. No automation
  changes, and there is no new language version.
  - A remote adapter's file is read only at a field its `describe` declares `kind: "file"` (or a
    resource's `fileRef`); the conformance CLI's new `files-declared` check names a field that
    answers one undeclared. File refs sent to a remote adapter (a write, a position's resources and
    evidence) no longer name Listen-Fire's credential or construction args.
  - A callback's `file` parameter is the calling system's handle, and stays data.
  - A run parked before this release that held a file in a value or a record's field resumes holding
    its descriptor as data (`READ` of it fails, naming it); a resource's file still revives as a
    file.
- Every file's bytes are read only for the team the run belongs to. A stored document is read only
  when it is the team's (`FILE()` artifacts and a manual run's uploaded files are now stored under a
  per-team key prefix; a plugin's stored document is the team's by its document row); the store
  reads a key only from a URI of its own bucket with no empty, `.` or `..` segment. A connected
  system's file is read only through the instance the run itself holds for that system, never one
  the file names. A file whose handle is a URL (email, WhatsApp) is fetched only from where its
  system's configuration says it issued it: the email provider's own storage; WhatsApp's configured
  Twilio account's media (none when `TWILIO_ACCOUNT_SID` is unset) or a URL this deployment exposed.
  A file written into text — a field, a prompt, a trace — is only its name, type, size and handle;
  its source, credential and URL are never written, and reading them off a file gives nothing.
  Anything else fails the run with `FileOutsideTeamError` (`FILE_OUTSIDE_TEAM`), never an empty
  read, and nothing is fetched. Operators: a `FILE()` artifact or a manual run's file stored before
  this release, still held by a parked run, is no longer readable by it.

### Changes to what a saved automation does (every language version)

- A field or child node named `__proto__`, in a node declaration or an extraction, is refused
  (`MOV_SHAPE_FIELD_PROTO`). It used to validate, but the extracted record never held the field:
  JavaScript set the record's prototype from the model's answer instead. A bug fix, not a language
  version: an automation declaring one now fails its check on every version; rename the field.
- A binding, a parameter or an alias named `__proto__` is refused (`MOV_NAME_PROTO`). The engine
  keeps a scope's names as an object's keys, and JavaScript reads that key as the object's
  prototype: a closure's parameter so named read as `{}`, and a parked binding so named was dropped,
  failing its resume. A bug fix, not a language version: rename it.
- A record plugin's answer whose data holds an own `__proto__` key (as JSON text makes one) keeps it
  as a key on both engines. Before, the TypeScript engine lost it: preparing the answer assigned
  each key, which made it the answer's prototype. Merging the data into the record still assigns, as
  JavaScript's `Object.assign` does, so the key becomes the record's prototype and a field read goes
  through it.
- A prototype a record plugin's data gives its record does not survive a park, on either engine: the
  parked record holds its own fields only.

### ev1-protocol

- Adapter protocol 2 gains module declarations, without a version bump: a manifest may declare
  `credentials` (`static` or `oauth2`, with its authorize and token URLs), `inbound` (the door's
  provider key, a signature scheme and the headers carrying it), `poll` and `periodic`. A request
  may carry the install's resolved `credential`, and a response (success or failure) a
  `credentialUpdate`. Three optional methods: `poll`, `refreshCredential` and `runPeriodic`. A
  declaration without its method, or a method without its declaration, refuses the manifest. An
  older server declares none of it and is unchanged; nothing in the host acts on it yet.

### ev1-public

- Contributors: the engine package now has public entries under `packages/movement-engine/public/` (the engine, host, run host, adapter, catalog, inbound, models, files, log, testing), and `code:type-check` in apps/api runs an engine boundary guard that fails if the API imports more engine internals than the recorded baseline. No change to a deployment.

### ev1-golden

- A golden corpus now records how every inbound door answers today (webhook-sync per provider, the
  remote adapter push doors, the shared Telegram bot, both Slack app doors, WhatsApp, Resend mail,
  `/api/cb`, `/api/asks`, the valuations webhook routes), with the callback URL of every provider key
  and every mount path. No behaviour changes; it is the baseline the shared inbound core must match.

### ev1-judge

- The entity identity judge (which candidate record is the one being written) moved into the engine package with its prompts as files; the hosted platform wires it to its model and Jev clients and decides exactly as before (replayed against recorded cases).

### ev1-filetext

- Reading a file's text (PDF text layer then OCR, decks, spreadsheets, CSV, audio) moved into its own
  package, `packages/file-text`. OCR, transcription, the spreadsheet model call, the byte source and
  the logger are passed in, so a shell without the hosted product can read files. The text read from
  the same files is unchanged.

### ev1-providers

- The model providers (OpenAI, Gemini, Claude on Vertex, Anthropic) and the embedding, image and
  transcription callers moved into a new `model-providers` package. Vendor SDKs load on first use,
  and the package reads no process environment; the hosted API passes its own. No behaviour change.

### ev1-pricing

- Model prices are data: `packages/movement-engine/lib/models/prices.json`, read through `pricing.ts`. The hosted product's costs are unchanged to the microdollar.
- `lf` now prices its model calls from the same table and charges them to the run, so a run's cost cap sees them.
- The extraction output budget is a host input (`outputBudget`) rather than an environment read inside the engine; the hosted product still reads `EXTRACTION_OUTPUT_BUDGET`.

### ev1-callbacks

- `lf` takes callbacks: a run's `callback(…)` is called at `lf serve`'s `POST /api/cb/<id>` (its
  `url`) or with `lf call <id> --body <values.json>`. The values are checked against the callback's
  parameters; the body runs once, then the run's `await cb-[:Called]->` resumes. A callback closes
  when its run ends, however it ends.
- `lf.yaml` takes `publicUrl`: where this lf is reached from outside. A callback's `url` is under it
  (else under where `lf serve` listens).
- `lf cancel <run> [--reason <text>]`: a parked run is settled failed with the reason, its
  callbacks closed. A run another lf process is stepping stops at its next statement.
- The hosted product's callbacks are unchanged (same table, ids, links and answers); their store now
  serves the run host core's callback family, which lf's SQLite store serves too.

### ev1-lfhost

- `lf-host`, a new Rust binary (`crates/lf-host`), is the first slice of the one-binary `lf`. It reads
  the same project (`lf.yaml`, the externals, the secrets) and `lf-host check` prints exactly what
  `lf check` prints: it starts the externals, builds the same catalog byte for byte, and runs the Rust
  checker natively. Nothing else of `lf` is in it yet; the TypeScript `lf` is unchanged and still
  the one to use.
- The run host's state can now live in a Rust SQLite store with the TypeScript lf's schema. The run
  host's contract suite drives it over a stdio JSON-RPC bridge (`lf-host --contract-store`) and it
  passes every case (30 of 30).
- `lf check` reports a file that does not parse at the column the parser names. It reported column 1
  for every such file.

### ev2-cbhost

- The hosted product now runs a fired callback's body with the same body runner lf uses (the run
  host's core). Webhook URLs, callback ids, door answers, database rows and the `fire_callback`
  work kind are unchanged, so callbacks already queued still run.

### ev2-plugins

- The bundled plugins' specs are data in the engine package (`movement-engine/public/plugins`): each
  one's parameters, declared output and effects, and whether it is priced. The hosted catalog reads
  them from there; the product keeps only each plugin's implementation and its catalogue page text.
  What the checkers see is unchanged (held against a recording taken before the move).

### ev2-secrets

- One secrets family for every host: resolve a credential, write it back at the version it was read
  at (a write against a newer version is refused), and refresh it at most once at a time, across
  processes too. The host refreshes an `oauth2` credential itself with the standard refresh-token
  grant at the token URL the module declares.
- The platform's connected credentials: the Dropbox refresh, and the Google and Gmail token
  rotations, now write back through it. Two workers that find the same expired Dropbox token now
  make one token call; before, both refreshed. The stored encryption and each payload's shape are
  unchanged, so existing connections read and write as before.
- `lf`: a refreshed token is written back under a lock file beside the secrets file, so `lf serve`
  and an `lf run` beside it spend a refresh token once. A credential from the environment is still
  used for the run only, with one warning.
- Adapter protocol 2, within version 2: a module whose manifest declares a credential is sent the
  install's credential on every call (only the fields it declares, only over HTTPS or loopback),
  and its `credentialUpdate` is written back, from a failed call too. An update naming a field the
  module does not declare is refused. In `lf` today; hosted installs do not store declarations yet.

### ev2-inbound

- Every inbound webhook now goes through one shared inbound core in the engine package (signature
  schemes, the capture-queue-ack pipeline, the emit and wake push doors, and an HTTP contract suite),
  so `lf` can serve the same doors next. Webhook URLs, signature headers and keys are unchanged for
  every provider.
- Fixed: a built-in provider's delivery is no longer refused 401 because an `x-listen-fire-signature`
  header beside its own good signature was wrong. That header now verifies remote installs only.
- Fixed: a webhook delivery whose receipt could not be queued was acked 200 and the receipt never
  ran. It now answers 500, so the provider retries and the stored receipt is queued again.
- Fixed: a webhook body over 100 KB is answered 413 with `{"error":"payload_too_large"}`, the doors'
  JSON error shape, instead of an HTML page.

### ev2-lfengine

- `lf-host run --event <file> [--dry-run]`, `lf-host resume [<run>]` and `lf-host runs` run movements.
  The Rust engine is linked into the binary and driven natively, not through WASM. A sleep or an await
  parks into the same SQLite state file the TypeScript `lf` writes, and either binary resumes it.
- Externals are processes reached over adapter protocol 2. Every answer is held to the protocol's
  schemas, files cross as URLs, and the per-run call ceiling and dry-run capture behave as in `lf`.
- On the example project, its fixtures and the reference fake CRM, both binaries print the same lines
  and leave the same state file and the same writes in the external.
- Not in `lf-host` yet: `serve` and the inbound doors, callbacks, `cancel`, model calls, credential
  refresh, and `run --webhook`. The TypeScript `lf` is unchanged and still has them all.

### ev3-oauthfake

- The dev loop has a fake OAuth2 provider in fake-channels (`/oauth`): authorize, token for the authorization_code and refresh_token grants with rotating refresh tokens, a protected endpoint, and injectable expiry and failures.
- With `MOCK_OUTPUT_ADAPTERS=true` the Dropbox auth client signs in and refreshes against it, and the fake Dropbox refuses access tokens the provider has expired.
- `pnpm dev:oauth setup`, `pnpm dev:inject oauth-expire|oauth-config` and `pnpm dev:inspect oauth` drive and read it; documented in `docs/dev-loop.md`.

### ev3-otherdoors

- The mail doors (Resend, Mailgun inbound, Mailgun events) and the shared Slack app and Telegram bot doors now run on the inbound core. Every path, header and signature is unchanged; the golden corpus gained 21 Mailgun cases and passes unchanged except the fixes below.
- Fixed: emit and wake bodies over 1 MB answer `{"error":"payload_too_large"}` with 413, like the webhook door (they answered express's HTML page).
- Fixed: a Mailgun event whose signature is the wrong length, or missing, answers 406 (it answered a 500 that Mailgun would retry).

### ev3-connect

- `lf connect <credential>` connects an OAuth credential the way its external's manifest declares
  it. lf prints the provider's sign-in URL and opens it, takes the redirect on a loopback port
  (`--redirect-port N` for a provider that wants an exact redirect URI, `--no-browser` to only
  print the URL), exchanges the code, and writes the tokens into the secrets file. The secrets
  entry must already name its external and your app's `client_id` (and `client_secret`); those
  and every other field are kept.
- One connect flow in the engine package, driven by the declaration (authorize and token URLs,
  scopes, where the client authenticates, PKCE, extra authorize parameters). The platform's
  Attio, Airtable, Dropbox, Google and Gmail sign-ins now run on it. Their callback URLs, the
  parameters of each authorize URL and code exchange, the 15 minute single-use state, and the
  stored credential shapes are unchanged, so existing connections and registered redirect URIs
  keep working. Slack keeps its own installer flow.

### ev3-lfdoors

- `lf serve` takes deliveries at `/api/public/webhook-sync/<provider>/<install>`, the same door the hosted
  product serves, on the shared inbound core. `/hooks/<external>/<install>` keeps working as lf's older
  name for it and still answers `202 { runs }` with the runs it started. The webhook-sync door queues
  events and answers `{ ok, eventsProcessed }`.
- An external that declares `inbound` in its manifest has its deliveries verified by the declared scheme.
  The secret is the install's `webhook_secret` field, or the field `webhook.secretField` in
  `lf-external.yaml` names. An external with only the `webhook:` block verifies as before.
- A signed delivery with a missing, empty or placeholder secret is refused, whatever the scheme.
- The push doors (`emit`, `wake`) and `lf run --webhook` run on the same core. A pull cursor an external
  returns from `preprocessInbound` is now kept in lf's state and handed back on the next delivery.
- A delivery with an unreadable body now answers 500 (it was 400), and a refusal now carries a code
  (`signature_invalid`, `unknown_provider`, `subscription_not_found`) in place of a sentence.

### ev3-kit

- A built-in integration can now be a module: written once with the module kit
  (`packages/module-kit`, `defineModule`), loaded in process by the platform and served as a
  protocol-2 process by `serve-module` everywhere else. A module reaches no part of the hosted
  product, no database and no recording layer; a check in each module's type-check holds that.
- Dealroom is the first: `@lf/dealroom` (`modules/dealroom`). Nothing changes for a team using it:
  the same requests, the same answers and the same polled events, held by a recording of the old
  adapter replayed against the module both ways. Switching back is one line (`BUILTIN_MODULES`).
- Plugins are modules too. A plugin module declares its plugins as one package, imported by tag
  (``import { `@lf/web` as web } from plugins``) and called through the protocol's new
  `invokePlugin`. The six bundled plugins are still the platform's own for now.
- `lf`: an `lf-external.yaml` may name a `module` instead of a command or a URL, and a plugin
  external is now served (its plugins checked and called). `lf-host` does the same, except a module
  that needs a declared credential, which it checks but cannot run yet.
- Adapter protocol 2 (no version bump): a manifest may declare `plugins`, paired with
  `invokePlugin`; the install manifest file keeps a module's declarations. When a module declares a
  signed inbound, the host refuses a delivery with a missing, blank or placeholder key, or a bad
  signature, whatever the scheme. Built-in doors keep their current behaviour until they move.

### ev4-lfcreds

- lf's secrets file is no longer edited by hand. `lf connect <module>` sets a module up once: it
  installs it if needed (a module package the project has, or a separately-run module at its
  server URL), then asks for its install's secrets — the server secret, the webhook secret
  (generated on enter), and your OAuth app's client id and secret with the loopback port it
  registered — and prints the redirect URIs to register. It never asks for a user's credential.
  `lf connect` with no module lists the modules it knows and whether each is set up.
- `lf credential add --module <module> [name]` creates a named user credential bound to that
  module and the credential its manifest declares (`--credential <declared>` when it declares
  several): it signs in at the provider for an OAuth 2 one, through a loopback redirect (default),
  `--headless` (print the sign-in URL, paste back the URL the browser was sent to), or `--public`
  (through `lf serve` at lf.yaml's `publicUrl`, at `/oauth/callback`); a static one's fields are
  asked for. `lf credential update <name>` signs in again (`--no-reauthorize` to only edit
  fields), `lf credential delete <name>`, `lf credential list` (never a value). The OAuth app
  stays with the install and is not copied into a user's credential.
- Each entry records what it is for: `module:` alone is a module's install, `module:` +
  `credential:` a user credential. An entry written by hand (`external:`) reads as before; `lf
  credential update` records its binding and keeps every field and its name, so webhook URLs
  naming it keep working. Writes go through the secrets file's lock, plain or SOPS (`sops set` /
  `sops unset`, never decrypted onto disk); a credential with fields from the environment is
  refused, since lf cannot write the environment.
- `lf connect <credential>` (wave 3) is replaced by `lf credential update <credential>`.

### lfr-secrets

- The Rust `lf-host` refreshes credentials. Before, it refused a call whose OAuth token was about
  to expire. Now it refreshes the token, as the TypeScript `lf` does:
  - when the token expires within 30 s, and once more when a call answers `unauthorized`;
  - from a module's declared `oauth2` credential (the standard grant at the declared token URL), or
    by the module's own `refreshCredential`, or by lf's `refresh_token` + `token_url` convention;
  - written back to where the fields came from: the plain secrets file in place (comments and order
    kept), a SOPS file through `sops set`, and for the environment, this run only, with one warning.
- One refresh at a time per credential. Within a process the callers share one refresh. Across
  processes they take the lock file beside the secrets file, the same lock the TypeScript `lf`
  takes, so the two binaries never spend one refresh token twice.
- `lf-host` sends a module the credential its manifest declares, on every call. Only the declared
  fields go, and only over HTTPS or to a loopback address. A `credentialUpdate` the module answers
  is written back, from a failed answer too.
- `lf-host connect [<module>]` and `lf-host credential add|update|delete|list` match the TypeScript
  `lf` commands, file format and output. Sign-in works by loopback, `--headless`, or `--public`.
  `--public` finishes through `lf serve`'s `GET /oauth/callback`; lf-host provides the handler, and
  its `serve` mounts it.
- `lf-host completion <bash|zsh|fish>` prints a tab-completion script. It completes the subcommands
  and their flags, the installed and known module names, and the credential names.

### lfr-serve

- `lf-host serve` serves what `lf serve` does: a provider's webhook deliveries (and the older
  `/hooks/<external>/<install>` address), an external's emit and wake pushes, callback calls at
  `/api/cb/<id>`, and due work drained every second. Deliveries are verified by the same seven
  signature schemes and the same signed-inbound rule, with the same 100 KB and 1 MB limits.
- `lf-host` runs callbacks: a run mints them, `lf-host call <id> --body <file>` or the door calls
  them, and the body runs once under the run's lease. `lf-host cancel <run> [--reason]` cancels a
  run, and `lf-host run --webhook` takes one delivery. Either binary can resume what the other
  left, callbacks included.
- `lf-host` reads lf.yaml's `publicUrl`; a callback's link is under it.

### lfr-store

- `lf-host` keeps run state in Postgres when `--store postgres://…` (or lf.yaml's `store:`) says so.
  It uses the hosted product's own tables (`automations.trigger_run`, `parked_run`, `work`, …), so
  the database needs the hosted schema applied; lf-host refuses a database without those tables.
  The default stays the SQLite file `.lf/state.db`.
- `lf-host drain [--until-idle] [--max-seconds N]` is a worker over the work queue: it claims due
  rows one at a time, runs them and exits when nothing is due or the time is up. Any number of
  workers can drain one Postgres store at once, and every run's work is done once.
- A Postgres store's rows belong to one team (`--team <uuid>`, else a fixed uuid for lf). A worker
  claims only its team's work.

### lfr-merge

- The five lf-host streams (upgrade, model calls, Postgres store, secrets and credential commands,
  serve) are one binary. Callbacks and cancel requests are store methods, served by the SQLite file
  and by Postgres alike, so `lf-host serve`, `call` and `cancel` take `--store` too.
- A module external no longer needs `LF_SERVE_MODULE`: lf-host finds module-kit's `serve-module`
  in the project's node_modules, then in the workspace it was built in, and names the fix when it
  finds none. lf.yaml's `startTimeout` (seconds, default 30; or `--start-timeout`) is how long a
  started external has to print its listening line.
- The Postgres store connects over TLS (rustls), verifying the server by default; `sslmode`
  keeps its libpq meaning (`disable`, `prefer`, `require`, `verify-ca`, `verify-full`) and
  `sslrootcert` names a CA file. lf.yaml's `store:` may read the URL from the environment
  (`store: { env: LF_STORE_URL }`) or a secrets entry's `url` field (`store: { credential: db }`);
  a URL with its password written in lf.yaml is refused.
- On Postgres, a run's trace is kept where the hosted product keeps it (a movement step per
  segment on `trigger_run.steps`, at `diagnostics.trace`), so a run another worker resumed shows
  its whole trace.
- `maxRunCostUsd` in lf.yaml caps what one run may spend, as the platform's
  `MOVEMENT_MAX_RUN_COST_USD` does: a run that meets it pauses before the priced call that would go
  over it, and `lf resume <run>` carries on with its usage reset. A callback body, which cannot
  pause, fails at the cap instead.
- An inbound pull cursor (a notify-then-pull source's) is kept only by the SQLite store; a
  Postgres store refuses it, because the hosted product keeps it on a webhook subscription row lf
  has no counterpart for.
### ev4-cleanup

- Dev loop: `pnpm dev:oauth setup` signs an existing Dropbox credential in again when the fake
  OAuth provider no longer knows its refresh token (a fresh checkout, a reset), so the first
  refresh after setup succeeds. An injected WhatsApp document is now a PDF with a text layer, and
  `pnpm dev:whatsapp setup` also provisions `wa_document_intake`, which extracts from it.
- `pnpm checks:corpus`: the reader pass over the still incomplete corpus no longer prints an
  upgrade-rate failure (the floor is checked on the final pass), and the pinned test-only language
  version 99 is accepted rather than warned about.
### ev4-small

- Granola and Evertrace are now modules, `@lf/granola` and `@lf/evertrace` (`modules/granola`,
  `modules/evertrace`), loaded in process by the platform and served by `serve-module` everywhere
  else. Nothing changes for a team using either: the same requests, the same answers, the same
  writes and the same polled events, held by a recording of each old adapter replayed against the
  module both ways. Switching either back is one line (`BUILTIN_MODULES`).
- Both are polled sources with no inbound (no webhook, so no signed-inbound rule applies). Their
  poll is now the module's declared poll: five minutes, the same default as before, and the
  `pollIntervalSeconds` listen option still overrides it.
### ev4-dropbox

- Dropbox is a module: `@lf/dropbox` (`modules/dropbox`). Nothing changes for a team using it: the
  same requests and answers, held by a recording of the old
  adapter replayed against the module in process and served as a process over protocol 2.
  Switching back is one line (`BUILTIN_MODULES`).
- Dropbox's OAuth credential is declared by the module. The platform, as its host, refreshes a token
  about to expire through the secrets family against its own Dropbox app (so a refresh still runs
  once at a time across processes) and hands the module a working token. The dev loop's fake still
  stands in for Dropbox through the module's base URL override.
- Files cross as handles. A Dropbox file read is a handle (its path) that the host redeems through
  `resolveFileRef`; bytes a write carries are read through the host (`ctx.files`). The platform now
  provides `ctx.files` (a team's own bytes). A served module hosts the bytes of a file it returns at
  a short-lived one-use URL and reads a file value's bytes from the URL the host sent; a file it
  returns names its owner type and handle in the wire's spelling.
### ev4-google

- Google Sheets is a module: `@lf/google-sheets` (`modules/google-sheets`). Nothing changes for a
  team using it: the same requests, the same answers and the same writes (create, grant and share a
  spreadsheet, table rows and unique-by overwrites, tab appends, named cells, cells), held by a
  recording of the old adapter replayed against the module in process and as a process. Switching
  back is one line (`BUILTIN_MODULES`).
- The platform now refreshes a module's Google token itself, five minutes before it expires (as
  google-auth-library did), once per credential however many calls find it stale, and stores it
  back in the shape the connect flow wrote. Stored credentials are unchanged.
- The spreadsheets a user granted are the module's own state (`ctx.kv`); on the platform that is the
  same grants table the picker writes, so existing grants carry over untouched.
- `serve-module` keeps a module's state in files when given `MODULE_STATE_DIR` (one file per team),
  and serves one install's construction arguments from `MODULE_CONSTRUCTION_ARGS` (the protocol
  carries none).
- Google Drive is a module: `@lf/google-drive` (`modules/google-drive`). Nothing changes for a team
  using it: the same requests, answers and writes (granted folders and files, a folder's children,
  a file's fields and bytes, folder creates, Google Doc imports and uploads), held by a recording of
  the old adapter replayed against the module in process and as a process. Switching back is one
  line (`BUILTIN_MODULES`).
- A module can now read files out and be handed files in. A file it reads names itself by its own
  handle and the host names it as the install's, so a run can fetch its bytes later; a file handed
  to a write is read at its URL, or else from the platform's files.
- `serve-module` serves a file's bytes at a one-time URL of its own when the module resolves them
  from its provider (set `MODULE_PUBLIC_URL` when callers reach it through a proxy).
- The platform's own Drive calls (the older pipeline outputs) now get their token per call from the
  platform's Google client, and send through Node's fetch instead of node-fetch.
- Gmail is a module: `@lf/gmail` (`modules/gmail`). Nothing changes for a team using it: the same
  requests, answers and sends (the mailbox search, a message's fields, its attachments and their
  bytes, sends and replies with files, and the poll for arriving mail with its checkpoint), held by
  a recording of the old adapter, for a signed-in mailbox and a delegated one, replayed against the
  module in process and as a process. Switching back is one line (`BUILTIN_MODULES`).
- Gmail's credential reaches the module as one set of fields whichever way the mailbox was
  connected. A signed-in mailbox is refreshed by the platform five minutes before expiry and stored
  back as before; a delegated mailbox's tokens are minted per scope by the deployment's service
  account, held in memory until they near expiry (previously minted per call) and never stored.
  The mailbox allowlist is checked before the module is handed anything.
- In the dev loop a delegated Gmail mailbox now authenticates to the fake with a placeholder bearer
  token instead of an API key parameter.
### ev4-plugins

- The six bundled plugins are one module, `@lf/web` (`modules/web`). Nothing changes for a team
  using them: the same model calls, searches, scrapes and stored documents, in the same order, and
  the same answers, held by a recording of the old plugins replayed against the module in process
  and as a process. Switching one plugin back is one line (`BUILTIN_MODULES`).
- A movement may import them as the package, as well as one by one:
  ``import { `@lf/web` as web } from plugins``, then `web.fetchUrl(u)`. Existing imports are
  unchanged.
- `lf`: `@lf/web` runs as any plugin external does (`module:` naming `modules/web`). Off the
  platform it reads models through Anthropic and the web through Bright Data, on a `web` credential
  whose fields are all optional; with no scrape provider it reads a page with a plain request. It
  has no profile reader, gated-document browser or document store there, so a LinkedIn address or
  a gated deck fails, naming what is not available off the platform (the research plugins log that
  failure and read on, as for any page that fails).
- `examples/lf-custom-plugin`: a plugin module of your own, in one file with no imports, dropped
  into a project's externals.
### ev4-crm

- **Behaviour change (action may be needed): Affinity, Airtable and Attio webhooks are now refused
  when their subscription has no signing secret.** The three now run as modules that declare a
  signed inbound, and the host refuses a delivery whose secret is missing, blank or `pending`, or
  whose signature is wrong (Henry's 2026-10-17 rule, one rule for every scheme). Before, Affinity
  accepted every delivery when no Webhook Signature Key was set, and Attio and Airtable verified
  against an empty secret. Affinity listeners need the account's Webhook Signature Key on the
  credential, then the listen re-registered. The API logs at boot how many live subscriptions this
  refuses, per module (a count only).
- Affinity, Airtable and Attio are modules: `@lf/affinity`, `@lf/airtable`, `@lf/attio`
  (`modules/<name>`), each on its module line in `BUILTIN_MODULES`. Webhook URLs, valid signatures,
  stored credentials and the connect flows are unchanged. A recording of each old adapter against
  fake-channels replays identically against the module in process and over protocol 2 (Airtable
  over protocol 2 without its `base:` argument, which the protocol does not carry). Switching back
  is one line per module.
- The module kit lends a module the host's models (`ctx.models`: Affinity's fuzzy matches and
  location formatting) and a fetchable URL for a held file (`ctx.files.expose`: Airtable
  attachments); each is refused by name where a host lends none (the `serve-module` command line
  lends no models). A module's credential may carry `refresh`, the host refreshing it with its own
  OAuth app (the platform does so for Airtable when a token is refused).
- Airtable and Attio declare an OAuth 2 credential in the protocol's token fields; the platform
  reads and writes its existing rows in their stored field names. Airtable's webhook refresh worker
  now reaches Airtable through the registry, so it follows the line.
### ev4-chat

- Telegram is a module: `@lf/telegram` (`modules/telegram`). Nothing changes for a team using it,
  whether it brings its own bot or connected the platform's shared bot: the same Bot API requests
  and the same answers, held by a recording of the old adapter replayed against the module in
  process and as a process. Switching back is one line (`BUILTIN_MODULES`).
- The module kit's context gains the host's record of who linked their account (`identities`: the
  platform's `/start` handshake writes it; a host with none refuses a listing and resolves no
  actor) and the host's name for the install's credential (`credentialRef`), which an owned file
  carries so it is redeemed on the same install.
- A team's own Telegram bot still has no signed inbound: it is registered without a secret token,
  so the door's unguessable URL stays its secret. Declaring one would refuse every existing bot.
- Slack is a module: `@lf/slack` (`modules/slack`). Nothing changes for a connected workspace: the
  same Web API requests and the same answers, held by a recording of the old adapter replayed
  against the module in process and as a process. The installer flow, the shared app's doors and
  their URLs are unchanged. Switching back is one line (`BUILTIN_MODULES`).
- Slack's webhook door now verifies under the module's declared signed inbound (`slack_v0`, the same
  header): a subscription whose signing secret is missing, blank or a placeholder is refused, where
  before an empty secret was a key like any other. Every subscription the platform created holds a
  generated secret, so none is affected.
- Outside the platform (lf, a module served as a process), Slack's `SLACK_MESSAGE` composition needs
  a model the host does not give a module yet, so it refuses by name; write the text instead.
### ev4-conncreds

- A separately run module's server secret belongs to its install; the provider credential belongs
  to the connection. `connect hs_alice using alice_hubspot` and `connect hs_bob using bob_hubspot`
  against one install: every call is signed with the install's server secret and carries the
  credential the connection names, refreshed by the host with the install's OAuth app, and a
  rotated token is written back to that same credential (compare-and-swap on the platform's
  row, lf's entry).
- Platform: a remote install can hold the host's OAuth app per declared credential (stored with
  its secret, never in the manifest). A provider credential is a `REMOTE` credential bound to its
  module (`app_id`) and to the declared credential it fills (new nullable column
  `external_service_credentials.declared_credential`; existing rows are untouched and read as
  before). Before this, `using` on a remote module could name only the install's own credential,
  and no module was sent a declared credential, so no saved movement depended on the old meaning;
  a run naming the install's own credential still means "no provider credential".
- Both checkers: a connection naming a credential bound to another module is refused
  (`MOV_CRED_WRONG_ADAPTER`, as before), and so, now, is one bound to a credential the module does
  not declare. The catalog snapshot carries the binding (`credentials.<name>.credential`,
  `adapters.<name>.declaredCredentials`); install secrets are never offered to `using`.
- lf: a module that declares a credential is connected with `using` (as on the platform); one
  that declares none is connected as itself once its install entry holds the server secret. A
  hand-written `external:` entry works as before. lf-host checks the same bindings, sends the
  connection's credential and signs with the install's secret, as the TypeScript `lf` does.

### r-small

- A team's own Telegram bot is now registered by the platform with a random secret token, and every delivery to it must carry that token (a missing or wrong one is refused). The shared bot is unchanged.
- `@lf/web` off the platform now reads plain PDF, PowerPoint and spreadsheet links through the file-text package; only LinkedIn profiles and gated document sources are still refused.
- The builtins handbook chapter's sections are headed by the v5 spellings (`builtins#Text.join`, `builtins#List.sum`); the language search still finds a function by its old name but never shows it.

## [v0.11.0] - 2026-10-12

Language version 4, **Luminous Owl**, arrives. New automations are written in it. The deploy check
moves an existing automation up to it when it validates cleanly there. An automation with an error,
or with a move-up warning (`MOV_MATCH_MISS_CONTINUES`, `MOV_HANDLE_UPDATED_IN_PLACE`,
`MOV_HANDLE_READ_FOUND`: the same text now does something different), stays on its version, shows
Review and lists the diagnostics, and behaves exactly as before. Read each warning, edit what
assumed the old behaviour, and upgrade with `upgradeAutomation`, acknowledging it.

### Language version 4, Luminous Owl: what breaks

Each item applies only to an automation on Luminous Owl (4). Versions 1 to 3 keep their old
behaviour exactly (proved by a version 3 conformance corpus). Every rule, with examples and
rewrites, is in the [Luminous Owl migration guide](docs/language/luminous-owl-migration.md).

- **A named `match` yields a handle or absent.** A miss binds absent and the block carries on. Why:
  a miss ending the enclosing scope was never the intent, and it made `match` useless as a lookup.
  Guard with `== null`, `!= null`, `EXISTS` or `ISNULL`. Unguarded use where a value is required is
  `MOV_ABSENT_REQUIRED`, and so is a `link` or `unlink` whose end may be absent. Move-up warning on
  every bound match, held until acknowledged: `MOV_MATCH_MISS_CONTINUES`.
  - An unnamed `match … { }` is `MOV_MATCH_UNNAMED`: write `existing = match … { … }` then
    `if existing != null { … }`.
  - `link a -[:e]-> { match … }` is `MOV_LINK_MATCH_BODY_RETIRED`: bind the match, then
    `if to != null { link a -[:e]-> to }`.
- **`created` and `committed` leave the write handle** (`MOV_HANDLE_FIELD_RETIRED`). Why: they made
  a write handle a different type from a read. `-[:@old]->` carries the pre-write record instead, so
  an automation can say honestly whether it created or matched, and what changed. `.created` becomes
  `NOT EXISTS(h-[:@old]->)`. `.committed` becomes `FIRST(h-[:@old]->) != h` (TRUE when the write
  landed; under `dry_run` a write that matched lands on the handle itself), or is dropped where
  `dry_run` is a literal on the instance. A `dry_run` create has an empty `@old`, so for a created
  record `!= h` alone does not say the write landed. `committed` remains in the run log.
- **`write org { … }` on a write handle updates the record `org` names in place.** `org` reads the
  new values below the line; before, it kept the values of its own write. Why: the handle names a
  record, so a write to it should change what it shows. Move-up warning
  `MOV_HANDLE_UPDATED_IN_PLACE`, held until acknowledged, on the unnamed form and on
  `x = write org { … }`, which names the same record.
- **Reading a field the write did not set, off its handle, reads the record as the write found it.**
  Before, it read what the system handed back from the write, often nothing. A field set with `?:`
  or `+:` counts as not set. Why: the handle names the record, so its fields are the record's.
  Move-up warning on each such read, held until acknowledged: `MOV_HANDLE_READ_FOUND`.

### Language version 4, Luminous Owl: new

- `-[:@old]->` on any write handle: empty when the write created (under `dry_run` too), a snapshot
  of the record as it stood when it matched, the handle itself under `dry_run` when the write
  matched (an in-place write included), and the previous handle after a second write. `@old` on a
  match handle, a traversal landing or a local node is `MOV_OLD_EDGE_NOT_A_WRITE`; any other `@name`
  is `MOV_ARTIFICIAL_EDGE_UNKNOWN`.
- The named match pattern: `existing = match … { … }` then `if existing != null { … }`.
- A write off a record found earlier (`x = write c { … }` on a traversal landing or a matched
  record) is a write handle, with `@old`.

### Changes to what a saved automation does (every language version)

These apply to every language version. Full text: the [migration guide's
appendix](docs/language/luminous-owl-migration.md#appendix-every-version-changes-in-full).

- The `else` arm of a null test narrows absence. It accepts only programs that were refused before.
- An adapter edge or collection whose name starts with `@` is left out of the catalog with a note,
  instead of failing the connection's `describe`.
- An Affinity identity candidate carries the organisation's or person's fields as Affinity holds
  them, not the asserted values.

### Fixed

- An awaited `parallel` or `race` whose arms are built at run time (`await parallel(arms)`) now
  binds its result as a value that nobody can type, as the same combinator does without `await`.
  Before, it was bound as a record, so writing it into a field was refused even when the arms
  returned values. Arms that return records are now accepted there too, because the result is still
  not typed from what its arms return. The same holds, as before, for a literal arm that returns a
  record (`await parallel([() => { return org }])`). Typing the result from its arms, so both forms
  are refused, is a follow-up.

### Security

- Data from a connected system or a webhook is always treated as data. Before, a value that copied
  the shape of one of the engine's internal objects could be run as part of the automation: a
  webhook body or a field answer could make the engine follow its edges and evaluate expression text
  it carried. The engine now marks its own objects in a way no data can carry. No automation
  changes, and there is no new language version.
- A record placed inside a value is now refused when the automation is validated, as a record placed
  directly in a field already was. This covers a write or match field (`MOV_WRITE_FIELD_TYPE`) and a
  plugin argument that takes structured data or declares no type (`MOV_CALL_ARG_TYPE`), with the
  record under a key of a dict, in a list, or in either arm of an `IF`. The message names where in
  the value the record sits. Before, such an automation validated, and the connector or plugin
  received the engine's internal description of the record, including the connection's schema and
  credential name, and passed it to the vendor. Write a field off the record in its place. For a
  record the automation wrote, you can instead spread the fields it was written with (`{ ...org }`).
  Passing a whole record to a plugin argument that takes structured data still hands the plugin the
  record's fields. This applies to every language version, with no new version:
  - An affected automation shows a Validation Issue at the next release's deploy check. Its runs
    fail with `MOVENG_CHECK` until the record is taken out of the value.
  - Operators will see one `[DeployCheck] PRESERVATION FAILURE` log line for each affected
    automation. This is expected for this release.
  - The class is not fully closed. On language versions 1 and 2 only, a record handed back by a
    function called inside an expression (`company: f()`, `summarise(data: { a: f() })`) is still
    accepted, and is a follow-up. Those versions do not type a call written inside an expression.
    Versions 3 and 4 refuse it.
- A file placed inside a value is now refused when the automation is validated, as a record is. A
  file goes only into a field that holds files. This covers a write or match field
  (`MOV_WRITE_FIELD_TYPE`) and a plugin argument that takes structured data or declares no type
  (`MOV_CALL_ARG_TYPE`). The file may be under a key of a dict, in a list, in either arm of an `IF`,
  in a dict that is spread, among the fields of a record handed whole to a plugin, or handed back by
  a function. A file written straight into a field that is not a file field is refused the same way,
  a text field included. The message says "a file, not a value" and names where in the value the
  file sits. Before, only a file written straight into a json field was refused; otherwise the
  automation validated, and the connector or plugin received the file's internal descriptor. Put the
  file in a file field, or put its text in its place (`READ(f)` inside a value,
  `COALESCE(READ(f), "")` for a whole field). A field that only takes files still refuses a record,
  in either arm of an `IF` or in a spread list. This applies to every language version, with no new
  version:
  - An affected automation shows a Validation Issue at the next release's deploy check. Its runs
    fail with `MOVENG_CHECK` until it is edited. Operators will see one
    `[DeployCheck] PRESERVATION FAILURE` log line for each affected automation.
  - Attio pulled a file out of any field of a record it was writing and uploaded it as an
    attachment. So a file written into an Attio text field worked by accident; it is now refused at
    validation. Write it into a file field instead.
  - Not closed yet, and follow-ups:
    - on language versions 1 and 2 only, a file handed back by a function called inside an
      expression, for the same reason as a record;
    - a file passed to a plugin argument typed text, or a dict holding a file passed to one
      (`tag(label: f)`, `tag(label: { a: f })`);
    - a dict holding a file passed to a plugin argument typed file (`ocr(doc: { a: f })`);
    - a file joined into a text (`"x${f}"`), which renders as `[object Object]`.
- A record or file reached through `COALESCE`, `IF … THEN … ELSE … END` or `MULTI`, through a
  `through [ … ]` stage, through an extraction input, or through `AT` on a record is now refused
  when the automation is validated, or rendered as its fields. Before, the checker could not see the
  record or file there, and the engine handed its internal object onward, to a connector, a plugin,
  an extraction prompt, or a lookup. This applies to every language version, with no new version:
  - `COALESCE`, `IF` and `MULTI` hold what their operands hold. A record or file in any arm is
    refused where the direct form is (`MOV_WRITE_FIELD_TYPE`, `MOV_CALL_ARG_TYPE`), as in
    `company: COALESCE(org, "x")`, `summarise(data: MULTI(org))` or
    `title: IF c THEN f ELSE "" END`. A name bound to one carries its arms, so
    `x = IF c THEN f ELSE org END` then `upload: x` is refused, and so is `x = COALESCE(org, "x")`
    then `company: x`. `AND` and `OR` always give true or false, so a record among their operands
    goes nowhere and is still accepted.
  - A `through [ … ]` stage's argument is held to what the plugin takes, as a plain call's argument
    is (`MOV_CALL_ARG_TYPE`). A record passed whole to an argument that takes structured data, or
    that declares no type, is handed the record's fields, as a plain call's is. Before, the stage
    was handed the engine's internal object.
  - An extraction prompt shows a record as its fields, as a JSON object, at any depth
    (`extract from [org]`, `extract from [{ a: org }]`). Before, the prompt showed the engine's
    internal object, including its handle and the connection it came from. A file input is read as a
    file, as before. Every record in an input is checked, at any depth and in any arm of an
    operator, and so is a record passed whole to a plugin argument that takes structured data or
    declares no type:
    - a record whose fields include a file is refused (`MOV_EXTRACT_CONTENT`, `MOV_CALL_ARG_TYPE`),
      because the prompt or plugin would receive the file's internal descriptor. Pass the file as an
      input of its own, or its text (`READ(f)`). This is decided by the record's type, so a record
      whose system has a file field is refused even when that field is empty;
    - a system's record, whose fields are read one at a time, is refused: pass a dict of the fields
      it needs. So is a connection (`extract from [crm]`);
    - a file inside an input (under a key) is refused: pass it as an input of its own.
    - The engine refuses all of these too (`MOVENG_UNSUPPORTED`), so a file's descriptor never
      reaches a prompt.
  - `MULTI(…)` of records or files now has the type of a list of them, so `FIRST(MULTI(org))` is the
    record `org` is, and the field rules apply to it. A `MULTI` of plain values stays untyped, as
    before. `FIRST`, `LAST`, `ONLY` and `AT` at an index over a list whose type says nothing
    (`MULTI(org, "x")`, `COALESCE([org], ["x"])`) may hand back any member, so a record or file
    among the members is refused where it lands.
  - An adapter instance written straight into a field (`company: crm`, or `x = crm` then
    `company: x`, in a write or a match) is refused with `MOV_WRITE_FIELD_TYPE`, as
    `company: { a: crm }` already was. This is older than this change.
  - `AT(r, key)` on a record is refused with `MOV_AT_RECORD_KEY` for any key that is not an index
    (`AT(org, "graph")`, `AT(org, k)`, `AT(COALESCE(org, "x"), "graph")`). A record is not a map;
    read a field with a dot (`` org.`Name` ``). Before, such a lookup read nothing or the engine's
    internal member.
  - An affected automation shows a Validation Issue at the next release's deploy check. Its runs
    fail with `MOVENG_CHECK` until it is edited.

## Earlier releases

Releases before v0.11 are kept one file per minor line, newest first:

- [v0.10.x](docs/changelog/v0.10.md) (v0.10.0 to v0.10.9)
- [v0.9.x](docs/changelog/v0.9.md) (v0.9.0 to v0.9.1)
- [v0.8.x](docs/changelog/v0.8.md) (v0.8.0 to v0.8.5)
- [v0.7.x](docs/changelog/v0.7.md) (v0.7.0)
- [v0.6.x](docs/changelog/v0.6.md) (v0.6.0 to v0.6.2)
- [v0.5.x](docs/changelog/v0.5.md) (v0.5.0)
- [v0.4.x](docs/changelog/v0.4.md) (v0.4.0)
- [v0.3.x](docs/changelog/v0.3.md) (v0.3.0)
- [v0.2.x](docs/changelog/v0.2.md) (v0.2.0)
- [v0.1.x](docs/changelog/v0.1.md) (v0.1.0 to v0.1.2)

[Unreleased]: https://github.com/listen-fire/listen-fire/compare/v0.12.13...HEAD
[0.12.13]: https://github.com/listen-fire/listen-fire/compare/v0.12.12...v0.12.13
[0.12.12]: https://github.com/listen-fire/listen-fire/compare/v0.12.11...v0.12.12
[0.12.11]: https://github.com/listen-fire/listen-fire/compare/v0.12.10...v0.12.11
[0.12.10]: https://github.com/listen-fire/listen-fire/compare/v0.12.9...v0.12.10
[0.12.9]: https://github.com/listen-fire/listen-fire/compare/v0.12.8...v0.12.9
[0.12.8]: https://github.com/listen-fire/listen-fire/compare/v0.12.7...v0.12.8
[0.12.7]: https://github.com/listen-fire/listen-fire/compare/v0.12.6...v0.12.7
[0.12.6]: https://github.com/listen-fire/listen-fire/compare/v0.12.5...v0.12.6
[0.12.5]: https://github.com/listen-fire/listen-fire/compare/v0.12.4...v0.12.5
[0.12.4]: https://github.com/listen-fire/listen-fire/compare/v0.12.3...v0.12.4
[0.12.3]: https://github.com/listen-fire/listen-fire/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/listen-fire/listen-fire/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/listen-fire/listen-fire/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/listen-fire/listen-fire/compare/v0.11.0...v0.12.0
[0.12.0-rc.10]: https://github.com/listen-fire/listen-fire/compare/v0.12.0-rc.9...v0.12.0-rc.10
[0.12.0-rc.9]: https://github.com/listen-fire/listen-fire/compare/v0.12.0-rc.8...v0.12.0-rc.9
[0.12.0-rc.8]: https://github.com/listen-fire/listen-fire/compare/v0.12.0-rc.7...v0.12.0-rc.8
[0.12.0-rc.7]: https://github.com/listen-fire/listen-fire/compare/v0.12.0-rc.6...v0.12.0-rc.7
[0.12.0-rc.6]: https://github.com/listen-fire/listen-fire/compare/v0.12.0-rc.5...v0.12.0-rc.6
[0.12.0-rc.5]: https://github.com/listen-fire/listen-fire/compare/v0.12.0-rc.4...v0.12.0-rc.5
[0.12.0-rc.4]: https://github.com/listen-fire/listen-fire/compare/v0.12.0-rc.3...v0.12.0-rc.4
[0.12.0-rc.3]: https://github.com/listen-fire/listen-fire/compare/v0.12.0-rc.2...v0.12.0-rc.3
[0.12.0-rc.2]: https://github.com/listen-fire/listen-fire/compare/v0.11.0...v0.12.0-rc.2
[v0.11.0]: https://github.com/listen-fire/listen-fire/compare/v0.10.9...v0.11.0
