---
"@listen-fire/module-kit": patch
---

The key form of awaits is gone from the kit, as from every host of release 0.13: its server no longer dispatches `resolveAwait`, an in-process module's `wakeKeys` answers are no longer validated, and `accepted(events, …)` no longer takes `wakeKeys`. Report arrivals instead (`accepted(events, { arrivals })`, adapter protocol 2.5).
