---
"@listen-fire/module-kit": minor
---

A module's `ensureEventSubscription`, `removeEventSubscription` and `refreshEventSubscription` are typed by both shapes of adapter protocol 2.6: a listen's in the settings form (`events`, unchanged), or a subscription for the arrivals on one listenable edge pushed to the connection or per scope (`EnsureEdgeSubscriptionInput`: `{ edge, filter?, scope?, callbackUrl, current? }`, and `RemoveEdgeSubscriptionInput`, `RefreshEdgeSubscriptionInput` naming the same `edge`, `filter` and `scope`), told apart by `edge`. A host makes one for every listen on the same connection, edge, filter and scope. Set `takenApplied: true` on an arrival you deliver only when you applied `filter` to it.
