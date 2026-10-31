# Stranded waits

Part of [the store slot](store-slot.md) and [the host families](host-families.md) (no version of its own).

A record a run waits on can be deleted while the run waits. From listen-fire 0.13 such a wait never resolves, on every module ([language-versions](language-versions.md); the reviews chapter's `deleted-records`). This document says what a host does about it: it keeps the wait parked, marks it stranded, and shows it.

## When a wait is stranded

A module reports a deletion in one of two ways:

- **A gone arrival:** `{ edge, key, gone: true }` among the arrivals it reports (adapter protocol 2.5).
- **An `awaitKeys` answer of `{ gone: true }`:** the record was already gone when the run's wait would have opened. The engine opens the wait all the same, without a key (`park.waits.open { gone: true }`). Nothing can arrive on it. A run has one such wait per edge, as it has one wait per edge of a record.

The store marks a wait stranded, once, when it finds the wait parked on a deleted record:

- `waits.log` logs a gone arrival while the wait is parked on its record;
- `parks.commit` or `parks.commitSegment` parks the wait on a record whose newest arrival after the wait's mark is gone;
- `parks.commit` or `parks.commitSegment` parks a wait opened without a key.

A wait opened but never parked is never stranded: a run that does not await the record does not wait on it.

## The newest report wins

A module may report a record gone wrongly, or the record may come back. So any arrival logged on a record after its gone arrival ends the stranding:

- the arrival wakes the record's parked waits, as any arrival does, and the wait reads it;
- `waits.log` clears `stranded_at` on every wait on the record, so `waits.stranded` no longer lists them;
- a gone arrival after that strands the parked waits again, with a new `stranded_at`.

A wait opened without a key has no record to report again: it stays stranded.

## What the host does

- **The wait stays parked.** A gone arrival wakes nothing and is no answer. What follows the `await` never runs unless the record reports again. A `race` with a `sleep` is the way out.
- **The store keeps when.** `stranded_at` on the wait's row (ISO 8601 in UTC with milliseconds, so it sorts as the instants do), until the record reports again or the run's rows go.
- **`listen-fire runs` shows it.** A parked run with a stranded wait still parked reads `parked (stranded)` (`--json`: `"stranded": true`).
- **`listen-fire runs show` says it.** One entry per stranded wait still parked, under `stranded` ([lf-json](../lf-json.md)):
  - `waiting on Interactions of slack C1:1730000000.000100 — its record was deleted, so nothing will arrive; a race with a sleep is the way out`;
  - for a wait opened without a key: `waiting on Interactions of slack — its record was deleted before the wait opened, so nothing will arrive; a race with a sleep is the way out`.
- **A wait no longer parked is no longer shown.** When a race's `sleep` wins, the run moves on; the store still lists the wait (`parked: false`).

## Reading them

`waits.stranded` ([store-slot](store-slot.md)) answers `[{ waitId, runId, adapterType, edge, key, at, parked }]`, oldest stranded first:

- `{ runId }`: the run's stranded waits. `runs` and `runs show` read this.
- `{ after?, limit }`: every run's, a page at a time, each page after the last wait of the page before (`after: { at, waitId }`). This is the feed for the records door.

A store module that does not serve `waits.stranded` (`method_not_implemented`) reports none.

## The event

The records door exposes stranded waits to modules: `records.strandedWaits` reads `waits.stranded({ after, limit })`. `@lf/system` turns each into one `Wait Lost Its Record` event, never to the stranded run's own listen: its fields and delivery are the system events' contract, [system-events.md](system-events.md). The event's `Record Id` is the wait's `recordId` (`waits.open`). Its 0.13 listen:

```
listen to sys-[e:Events WHERE e.Kind == "Wait Lost Its Record"]-> fire report
```

lf-platform's `@lf/system` adds the same event.

## Changes

- **2026-10-31** (listen-fire 0.13.0): written. A deleted record strands the waits parked on it, until the record reports again; `listen-fire runs` and `runs show` say so; `waits.stranded` reads them.
