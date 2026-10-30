# Changelog

## Unreleased

- `inbound.keepDelivery` may carry a delivery's `arrivals` (`DeliveryArrivals`), logged in the same write after the receipt: each `fire_event` row gains `arrivalMark`, a `wake_await { waitId }` row is queued per wait they answer, and `Kept` answers them as `wakes`. A store module built on the kit implements it, and lists `waits.log` in its manifest (listen-fire refuses a delivery that reports arrivals to a store that does not); `NewWork` is now `Serialize`. `waits.log` skips a repeat: an arrival whose identity and version its record's edge logged within the retention.
- `WaitsNote` carries `leaf`: the address of the leaf the noting segment resumed, when it resumed one. A store module built on the kit keeps such a note when `parks.finishLeaf` finishes that leaf or `parks.commit` parks at its address, and drops it when `parks.claimLeaf` claims the leaf again (that segment died), so its arrival is read again (docs/contracts/store-slot.md).
- `WaitsNote` carries `fence`, the noting segment's run lease: a store module built on the kit refuses the note (`run_lease_lost`) when the run is not leased under it, so a segment that lost its run notes nothing.
- The store slot's method table serves `parks.commitSegment { runId, teamId, fence, resumed, joins, parks, settle, owedRaces, settledRace }`: a segment's join counts, its parks, the end of the leaf it resumed, the run's settle (`SegmentSettle`, as `runs.settle` takes it, or none), the races it owes (`OwedRace`, each queued as a `settle_race` work row) and the race it settled (its row deleted), as one fenced write, answering the `wake_await` rows it queued for the waits it parks whose arrivals are unread or whose record is gone. A store module built on the kit implements it. listen-fire 0.13 calls it at the end of every segment that parked, recorded a join, resumed a leaf or settled a race, and fails a run whose store does not answer it. Of the other segments, one that settles its run does so with `runs.settle` alone, and one that leaves its run as it stands writes nothing (a callback's body that parked nothing, or a failed segment of a run already settled). (`ParksCommit` carries no `resumed`.)
- The store slot's method table serves `parks.owedRaces { runId }`: the run's `settle_race` rows' payloads (`OwedRace`), oldest first. listen-fire 0.13 reads it as each segment ends, and never settles a run `completed` while it owes a race. `joins.deleteFrames` drops the `settle_race` rows owed at the frames it deletes, and `leases.dropRunState` drops the run's.
- The store slot's method table serves the waits family: `waits.mark`, `waits.log`, `waits.open`, `waits.arrivals`, `waits.note` and `waits.sweep`, and `parks.commit`'s park may be `{ kind: "wait", waitId }`. A store module built on the kit implements the six new `Store` methods (docs/contracts/store-slot.md).
- `Reference`'s free members are documented as the 0.13 ones: `listenable`, `cursor`, `identity`, `version`, `resolvesEmpty`, `readable`. A module built on the kit declares `listenable` where it declared `awaitable` and `watchable`; a 0.13 `listen-fire` refuses the retired two.

## 0.12.8 - 2026-10-27

- The store slot's method table serves `runs.rerun { runId, input, at, fence }`, which starts a failed run's next attempt as one fenced write (`null` when the run's status is not `failed`). A run row may answer `attempt` and `attempts` (the earlier attempts, oldest first). A store module built on the kit can now serve `lf runs rerun`.

## 0.12.6 - 2026-10-25

- A module's manifest states the adapter protocol minor it uses (`protocolMinor`), computed from its features; a declared `protocolMinor` can raise it, never lower it.
- Its own version from here on.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
