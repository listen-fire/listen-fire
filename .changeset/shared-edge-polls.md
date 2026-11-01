---
"@listen-fire/module-kit": minor
---

A module's `poll` is a poll of a listenable edge (`PollEdgeInput`: `{ edge, filter?, scope?, cursor? }` → `PollEdgeAnswer`: `{ arrivals, cursor? }`). A host polls an edge once for every listen on the same connection, edge, filter and scope. Set `takenApplied: true` on an arrival only when the module applied `filter` to it; otherwise the host checks the whole filter itself. An entry point may declare its root collection's `capability`.
