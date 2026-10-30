# Changelog

## Unreleased

- `inbound.keepDelivery` may carry a delivery's `arrivals` (`DeliveryArrivals`), logged in the same write after the receipt: each `fire_event` row gains `arrivalMark`, a `wake_await { waitId }` row is queued per wait they answer, and `Kept` answers them as `wakes`. A store module built on the kit implements it, and lists `waits.log` in its manifest (listen-fire refuses a delivery that reports arrivals to a store that does not); `NewWork` is now `Serialize`. `waits.log` skips a repeat: an arrival whose identity and version its record's edge logged within the retention.
- The store slot's method table serves the waits family: `waits.mark`, `waits.log`, `waits.open`, `waits.arrivals`, `waits.note` and `waits.sweep`, and `parks.commit`'s park may be `{ kind: "wait", waitId }`. A store module built on the kit implements the six new `Store` methods (docs/contracts/store-slot.md).
- `Reference`'s free members are documented as the 0.13 ones: `listenable`, `cursor`, `identity`, `version`, `resolvesEmpty`, `readable`. A module built on the kit declares `listenable` where it declared `awaitable` and `watchable`; a 0.13 `listen-fire` refuses the retired two.

## 0.12.8 - 2026-10-27

- The store slot's method table serves `runs.rerun { runId, input, at, fence }`, which starts a failed run's next attempt as one fenced write (`null` when the run's status is not `failed`). A run row may answer `attempt` and `attempts` (the earlier attempts, oldest first). A store module built on the kit can now serve `lf runs rerun`.

## 0.12.6 - 2026-10-25

- A module's manifest states the adapter protocol minor it uses (`protocolMinor`), computed from its features; a declared `protocolMinor` can raise it, never lower it.
- Its own version from here on.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
