---
"@listen-fire/system": minor
"@listen-fire/embed": minor
---

`@lf/system` knows an arrival a listen could not judge that is itself one of its `Arrival Not Judged` events by what landed: a landing with that `Kind` on its own `Events`. Before, it matched a prefix of the record id it minted. `SystemRecords`' `UnjudgedArrival` gains `adapter` (the module the arrival came from) and `landing` (what landed, as its module reported it), both `null` when the host kept none; the records door answers both. `@listen-fire/embed`'s `dispatch` answers each `notJudged` with `adapterType` and `landing`: keep them with the fact. The `Event` record programs read is unchanged.
