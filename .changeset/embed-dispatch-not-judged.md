---
"@listen-fire/embed": minor
---

`dispatch` answers `{ runs, notJudged }`: beside each run's outcome, every arrival a listen could not judge (`{ program, movement, pipeline, arrival, edge, identity, recordId?, reason, deliveryId }`), the fact listen-fire keeps as `Arrival Not Judged`, so an embedder can alert on it or deliver it again. Before, it was one log line. `dispatch` also refuses a delivery it cannot route, naming why: from a module the host was not given, for a connection the tenant does not hold, with an arrival that does not parse, or with one naming no `key` on an edge that is no root of the module's schema. Before, each ran nothing without a word. A run that ends in its first segment clears the waits its delivery opened (a failed one is torn down), as listen-fire does, so a tick's sweep forgets the later arrivals on those records.
