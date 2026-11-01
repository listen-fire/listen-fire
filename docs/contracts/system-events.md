# System events

What `@lf/system` reports about the host it runs on, and how a host feeds it. The module is ordinary: no engine, checker or language support names it. It reads a host's facts about its runs, waits and releases, and turns them into arrivals on one listenable edge. The module's `types.ts`, `adapter.ts` and `poll.ts` are this contract's one definition; a host adopts it by depending on them and handing in its own facts.

## The edge and the event

One root edge, `Events`, lands on one record, `Event`. A listen names the kinds it wants by `Kind`:

```
sys = connect system

function report(e: <sys-[:Events]->>) { … }

listen to sys-[e:Events WHERE e.Kind == "Run Failed"]-> fire report
listen to sys-[e:Events WHERE e.Kind IN ["Run Failed", "Wait Lost Its Record"]]-> fire report
```

- The module takes `Kind ==` and `Kind IN [...]` on literals. Its poll reads only the asked kinds and marks each arrival `takenApplied`. A WHERE it cannot read leaves it reading every kind, and the host judges the WHERE itself.
- `Events` with no WHERE hears every kind.

Every event carries the same fields:

| field | what it is |
|---|---|
| `Event Id` | names the event: the same on every poll that finds it (the arrival's identity) |
| `Kind` | which of the seven kinds below |
| `Automation` | the program the event is about (its movement); empty when it concerns none |
| `Automation Id` | that program's id (on listen-fire `<file>:<movement>`) |
| `Run Id` | the run it is about; empty when it concerns none |
| `Version` | the release involved; empty when none is |
| `Reason` | what happened, in words |
| `Url` | where a person sees it; empty where the host has no such page |
| `At` | when it happened (UTC) |
| `Adapter`, `Edge`, `Record Id` | for `Wait Lost Its Record`: the module, the edge and the deleted record. For `Arrival Not Judged`: `Edge` and `Record Id`, the edge it arrived on and the record that landed. Empty on every other kind |
| `Listen`, `Delivery Id`, `Arrival Id` | for `Arrival Not Judged` only: the listen that could not judge the arrival (its pipeline, on listen-fire `listen:<file>:<movement>:<digest>`), the kept delivery it came in (empty when the host kept none), and the arrival as that listen names it (on listen-fire its edge, record, identity and version). Empty on every other kind |
| `Attempt` | for `Arrival Not Judged` only, a number: 0 as the arrival was delivered, one more for each replay that still could not judge it. 0 on every other kind |

## The kinds

| kind | about | listen-fire reports it |
|---|---|---|
| `Run Failed` | a run that ended failed (never a rehearsal) | yes |
| `Run Paused` | a run paused at its cost limit | never: it fails a run at its cost cap (`maxRunCostUsd`) instead |
| `Wait Lost Its Record` | a wait parked on a deleted record ([stranded-waits.md](stranded-waits.md)) | yes |
| `Arrival Not Judged` | a listen that could not tell whether an arrival fires it (below) | yes |
| `Release Applied` | a release the host first runs under | yes: once per store, when `serve` or `drain` first opens it under a new release |
| `Validation Issue` | a saved program that does not validate under the running release | never: it refuses to serve a project that does not check |
| `Deprecated Version` | a saved program pinned to a deprecated language version | never, for the same reason |

## Arrival Not Judged

The host never relies on a provider sending a delivery again: it takes and acknowledges every one. So a listen it cannot judge an arrival for is the host's own failure, reported here, not left to a retry.

- A listen cannot be judged when its filter reads a field the module could not read (`unknown` on the arrival's landing or a parent, [adapter-protocol.md](adapter-protocol.md), Reporting arrivals: Slack's `Mentions App` when `auth.test` fails, a channel's `Name` when `conversations.info` fails), or a record the arrival does not carry, or a record that does not say its record type.
- It fails for that listen alone: the listen runs nothing for the arrival, and every other listen on it is judged and runs as usual.
- One event per listen, arrival and attempt. A redelivery, a drain running the delivery's row again, or another poll finds the same fact and reports nothing more: the store keeps the fact once per listen, arrival and attempt (`unjudged.note`), and its `Event Id` is `arrival_not_judged:<listen>:<arrival>:<attempt>`. The first judging is attempt 0; each replay (below) that still cannot judge it is the next attempt, reported once more.
- `Automation` and `Automation Id` are the listen's program; `Run Id` is empty: no run started.
- Each is `notFor` the listen that could not judge the arrival, so a listen on `Events` is never told of its own.
- An arrival that is itself an `Arrival Not Judged` event is never reported in turn: the fact is kept and the module logs it. Two listens on `Events` that cannot judge such events would otherwise report each other's without end, once a poll, with no run for the loop breaker to count.
- When a run's write caused the arrival (the loop breaker's ledger, below), the event is `about` that run, so a run it fires continues that run's chain.

### Putting the arrival through the listen again

Once the provider answers again, `listen-fire listens replay <file>:<movement> --delivery <Delivery Id>` puts the kept delivery through that listen (or `--event <Event Id>`, which names the listen and the delivery itself):

- The delivery's kept request is read again by its module, as it was received: its lookups are made afresh, under the pull cursor it was first read against. Its signature is not checked again, and is not kept: the request is listen-fire's own capture, and holds only the headers its module declares it reads (`inbound.captureHeaders`). A module that checks its own requests (`inbound.scheme: module`) is told it is a replay (`checkInbound`'s `replayed`, adapter protocol 2.6) and skips its signature and timestamp checks; the host sets that only for a replay, never for a request that arrived. A module older than 2.6 ignores it and refuses the request.
- Only the arrivals the delivery brought are judged again: the delivery keeps their ids. A module that reads from a pull cursor (Airtable) reports, read again from that cursor, every change since, and those of later deliveries are left alone.
- A poll's page made no request. The delivery kept the arrivals the poll read, and those are judged again against the named listen, the module asked nothing. Only a listen that shared the poll takes them, as the module read them for the filters those listens take.
- What it brings is judged against the named listen alone. Every other listen on the delivery is left as it is, whatever it did.
- A run it fires goes the way a delivery's run does, in one write: a replay delivery of its own (`replayOf` the one replayed), the run's waits opened with its trigger noted on them, the records its arrival carries handed to it. It runs in the command.
- The listen's receipt holds: a listen that ran the arrival before runs nothing, and says so. `--force` runs it again, a new run under a receipt of its own.
- A listen that still cannot judge it is reported again as the next attempt, its `Delivery Id` still the delivery replayed, and the command exits 1.
- A delivery received more than `deliveries.retainDays` ago is refused by name, as is one that kept no request (one kept before deliveries kept theirs).

## Never your own

A program is never told about its own listen's failures or waits.

- Each event about a run is `notFor` the listen that started that run (adapter protocol 2.6 `Arrival.notFor`, the listen's pipeline). The host skips firing that one listen with it.
- Without it, a failure handler that fails would report itself forever.

A handler that fails on another listen's failures, which fails in turn, is a chain of runs, and the host's loop breaker caps it:

- Each event about a run is `about { recordType: "Run", externalId: <run id> }`.
- The host keeps each fact about a run in its write ledger as that run's write of its own record, at the run's place in its chain.
- So the run an event fires continues the chain of the run it is about, and the listen that would start run `loopDepth + 1` is paused (`LISTEN_LOOP`).

## Delivery

- `Events` is polled (`delivery: polled`), every 60 seconds by default (`pollEverySeconds`). An operator tunes it per connection with lf.yaml's `pollEvery`.
- A fact is read only once it is older than the settle lag (10 seconds by default), so a row committed late is never passed over. At most a page of rows (100 by default) is read per kind per poll; the rest waits for the next.
- An operator sets both in the install's env (`env:` in the module's lf-external.yaml, as any module takes its settings): `SYSTEM_SETTLE_SECONDS` (default 10) and `SYSTEM_PAGE_SIZE` (default 100). The host does not need the settle lag: the write ledger keeps a fact for as long as it keeps any write, counted from when the door hands it out (below).
- So an event arrives at least a settle lag, and usually a minute or so, after it happened.
- The first poll only sets the marks, at now less the settle lag, and emits nothing: going live never replays what happened before.
- So a fact within the settle lag before the first poll is reported by the next one. A fresh project's first `serve` or `drain` notes its release as it opens the store, usually seconds before that first poll, so its `Release Applied` is reported once; an older release is not.
- A kind a listen asks for that its cursor has no mark for (the module learned it after the cursor was made) is armed at now less the settle lag on that poll, and reports nothing from before.
- Marks are kept per kind as `(at, id)`, so two facts at one instant are neither skipped nor reported twice.

## The records door

listen-fire hands `@lf/system` its facts at `POST {host}/api/public/adapter/{module}/records`, beside the models, OCR and limits doors, under the host token (`LF_HOST_TOKEN`). A module reads it as `ctx.records.read(method, params)` (module-kit). The door answers `{ result }`, or an error with a `message`. It names no event kind:

| method | params | result |
|---|---|---|
| `records.failedRuns` | `{ after?: { at, runId }, until, limit }` | failed runs, oldest first: `{ runId, file, movement, listen, rehearsal, reason, at }` |
| `records.pausedRuns` | as `failedRuns` | always `[]` on listen-fire, which pauses no run |
| `records.strandedWaits` | `{ after?: { at, waitId }, limit }` | stranded waits, oldest first: `{ waitId, runId, file, movement, listen, adapterType, edge, recordId, parked, at }`, read from the store's `waits.stranded` |
| `records.releases` | `{ after?: { at, version }, limit }` | releases, oldest first: `{ version, at }`, from the store's `releases.list` |
| `records.unjudgedArrivals` | `{ after?: { at, pipeline, arrival, attempt? }, limit }` | listens that could not judge an arrival, oldest first: `{ pipeline, arrival, file, movement, deliveryId, edge, recordId, reason, cause, at, attempt }`, from the store's `unjudged.list` |
| `records.webBaseUrl` | none | `null` on listen-fire, which has no runs page |

- `listen` is the pipeline of the listen whose arrival started the run; `null` for one no listen started.
- `recordId` is the record the wait waits on, as the engine named it at `park.waits.open`; `null` for a wait opened before waits named their record.
- For an unjudged arrival: `pipeline` is the listen; `arrival` its receipt key (`<edge>:<key>:<identity>:<version>`, compared, never parsed); `deliveryId` the kept delivery, `null` for none; `recordId` the landing's; `cause` the run whose write caused the arrival, `null` for none; `at` when the host found it could not judge it; `attempt` which judging it was (0 as delivered, one more per replay; an `after` without one is 0).
- What is kept, and for how long. The fact is kept as long as a delivery is (lf.yaml `deliveries.retainDays`, 14 days by default, at least 1): each note forgets the facts older than that. The delivery `Delivery Id` names is kept as long, once its runs have settled and its rows are done (`listen-fire deliveries show <id>`). It keeps the request it was received as, its body and the headers its module reads, for as long, never longer: that is what a replay reads again. The request is sensitive (a message's text, a person's address): `deliveries show` prints it only when asked (`--request`).
- The door keeps every fact about a run it hands out in the write ledger, as above, stamped with when it hands the fact out, not when the fact happened. So the ledger keeps it for as long as it keeps any write (`loopWindow` and the slowest poll), however old the fact is and whatever settle lag the module has.
- One row stays per run: a fact read again (another listen's poll, a retry) replaces the run's earlier one, and the door forgets what the ledger no longer keeps, so a project whose runs write no records does not grow it for good.
- The door keeps the run an unjudged arrival names as its `cause` in the write ledger, as it keeps any run it reports on.
- The store methods it reads are in [store-slot.md](store-slot.md): `runs.failed`, `releases.note`, `releases.list`, `unjudged.note`, `unjudged.list` and `waits.stranded`.

## Adopting it elsewhere

A host that keeps its facts in its own tables hands them in with `systemModuleWith((ctx) => records)`, its `SystemRecords` (`records.ts`). lf-platform does this, and:

- moves its module to the one `Events` edge with `Kind` (from one edge per kind);
- answers `failedRuns`, `pausedRuns`, `strandedWaits`, `releases`, `unjudgedArrivals` and `webBaseUrl` from its tables;
- keeps an unjudged arrival wherever its host judges an arrival undecided (`listenFires` answers `{ undecided }`), once per listen, arrival and attempt, with the listen's pipeline, the delivery, the arrival's receipt key, edge, record, reason, the run whose write caused it, the time and the attempt, as listen-fire's host does;
- keeps each delivery's request as received (its body, and only the headers its module names in `inbound.captureHeaders`, beside the content type and the delivery id header under a declared scheme; never a signature or another credential) with the ids of the arrivals it brought, for as long as it keeps the delivery, and shows it only to a person who asks;
- offers a replay of one listen through a kept delivery, as `listen-fire listens replay` does: its module's inbound handling run again on the kept request without verifying it, keeping only the arrivals the delivery brought (a module that checks its own requests is told it is a replay: `checkInbound`'s `replayed`), or, for a poll's delivery, the arrivals the poll read judged again with the module asked nothing; the arrivals judged by that listen alone through its one write (waits registered with the run, its trigger noted on them), its receipt honoured unless forced, and a listen that still cannot judge it kept as the next attempt;
- gives its deploy check's `Validation Issue` and `Deprecated Version` a member of `SystemRecords` (the module reads none today: listen-fire has none to give);
- marks each event `notFor` the failed run's own automation;
- keeps each failure, pause and stranding in its loop breaker's ledger, as listen-fire's records door does, so a chain of failure handlers is capped.

## Changes

- 0.13.0: written, with `@lf/system` bundled in listen-fire.
- 0.13.0 (2026-11-01): `Arrival Not Judged`, with the `Listen`, `Delivery Id`, `Arrival Id` and `Attempt` fields and `records.unjudgedArrivals`. Why: the host takes every delivery, so a listen it cannot judge is its own failure, and is made visible rather than left to a provider's retry.
- 0.13.0 (2026-11-01, later): a kept delivery keeps its request, and `listen-fire listens replay` puts it through one listen again; each replay that still cannot judge the arrival is an attempt of its own, and the `Event Id` names the attempt (`…:<attempt>`, 0 for the first judging). Why: an event a listen could not judge needs a way back through that listen once the provider recovers.
- 0.13.0 (2026-11-01, latest): a replay tells a module that checks its own requests it is one (`checkInbound`'s `replayed`, adapter protocol 2.6), so it skips its signature and timestamp checks; a poll's delivery keeps the page it read, and a replay judges those arrivals again, asking the module nothing. Why: a Stripe delivery replayed days later was refused by its five minute window, and a polled listen could not be replayed at all.
