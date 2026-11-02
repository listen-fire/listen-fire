---
"@listen-fire/engine-contracts": patch
---

The `Adapter` type matches adapter protocol 2.6's subscriptions for an edge's arrivals. `removeEventSubscription` and `refreshEventSubscription` take either an edge's input (`edge`, `filter?`, `scope?` a record id, as `ensureEventSubscription` does) or the 0.12 webhook's (`scope` a `{ base, table }` record), so a module class that requires `edge` is assignable to `Adapter`. New types: `EdgeSubscription`, `EnsureEdgeSubscriptionInput`, `RemoveEdgeSubscriptionInput`, `RefreshEdgeSubscriptionInput` (module-kit re-exports them).
