---
"@listen-fire/module-kit": patch
---

Adapter protocol 2.6, arrivals for listens: an arrival a module reports (beside `preprocessInbound`'s events, on `accepted(events, { arrivals })`, or at the `wake` door) may name no `key` when it lands on a root edge, and may carry `parents`, `about`, `notFor` and `takenApplied` (`Arrival` in `@listen-fire/engine-contracts`). A module that reports a root arrival states `protocolMinor: 6`.
