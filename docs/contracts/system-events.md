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
| `Kind` | which of the six kinds below |
| `Automation` | the program the event is about (its movement); empty when it concerns none |
| `Automation Id` | that program's id (on listen-fire `<file>:<movement>`) |
| `Run Id` | the run it is about; empty when it concerns none |
| `Version` | the release involved; empty when none is |
| `Reason` | what happened, in words |
| `Url` | where a person sees it; empty where the host has no such page |
| `At` | when it happened (UTC) |
| `Adapter`, `Edge`, `Record Id` | for `Wait Lost Its Record` only: the module, the edge and the deleted record; empty on every other kind |

## The kinds

| kind | about | listen-fire reports it |
|---|---|---|
| `Run Failed` | a run that ended failed (never a rehearsal) | yes |
| `Run Paused` | a run paused at its cost limit | never: it fails a run at its cost cap (`maxRunCostUsd`) instead |
| `Wait Lost Its Record` | a wait parked on a deleted record ([stranded-waits.md](stranded-waits.md)) | yes |
| `Release Applied` | a release the host first runs under | yes: once per store, when `serve` or `drain` first opens it under a new release |
| `Validation Issue` | a saved program that does not validate under the running release | never: it refuses to serve a project that does not check |
| `Deprecated Version` | a saved program pinned to a deprecated language version | never, for the same reason |

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
| `records.webBaseUrl` | none | `null` on listen-fire, which has no runs page |

- `listen` is the pipeline of the listen whose arrival started the run; `null` for one no listen started.
- `recordId` is the record the wait waits on, as the engine named it at `park.waits.open`; `null` for a wait opened before waits named their record.
- The door keeps every fact about a run it hands out in the write ledger, as above, stamped with when it hands the fact out, not when the fact happened. So the ledger keeps it for as long as it keeps any write (`loopWindow` and the slowest poll), however old the fact is and whatever settle lag the module has.
- One row stays per run: a fact read again (another listen's poll, a retry) replaces the run's earlier one, and the door forgets what the ledger no longer keeps, so a project whose runs write no records does not grow it for good.
- The store methods it reads are in [store-slot.md](store-slot.md): `runs.failed`, `releases.note`, `releases.list` and `waits.stranded`.

## Adopting it elsewhere

A host that keeps its facts in its own tables hands them in with `systemModuleWith((ctx) => records)`, its `SystemRecords` (`records.ts`). lf-platform does this, and:

- moves its module to the one `Events` edge with `Kind` (from one edge per kind);
- answers `failedRuns`, `pausedRuns`, `strandedWaits`, `releases` and `webBaseUrl` from its tables;
- gives its deploy check's `Validation Issue` and `Deprecated Version` a member of `SystemRecords` (the module reads none today: listen-fire has none to give);
- marks each event `notFor` the failed run's own automation;
- keeps each failure, pause and stranding in its loop breaker's ledger, as listen-fire's records door does, so a chain of failure handlers is capped.

## Changes

- 0.13.0: written, with `@lf/system` bundled in listen-fire.
