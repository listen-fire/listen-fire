---
"@listen-fire/module-kit": minor
---

A module's `poll` is typed by both shapes of adapter protocol 2.6: a listen's poll in the settings form (`PollInput` → `PollAnswer`, unchanged), or a poll of a listenable edge (`PollEdgeInput`: `{ edge, filter?, scope?, cursor? }` → `PollEdgeAnswer`: `{ arrivals, cursor? }`), told apart by `edge`. A host polls an edge once for every listen on the same connection, edge, filter and scope. Set `takenApplied: true` on an arrival only when the module applied `filter` to it; otherwise the host checks the whole filter itself. An entry point may declare its root collection's `capability`.
