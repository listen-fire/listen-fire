---
"@listen-fire/system": minor
---

`Arrival Not Judged`: a listen that could not tell whether an arrival fires it (its filter reads a field the module could not read) is reported once per listen and arrival, with the new `Listen`, `Delivery Id` and `Arrival Id` fields, `notFor` that listen. `SystemRecords` gains `unjudgedArrivals`, read over listen-fire's records door as `records.unjudgedArrivals` (docs/contracts/system-events.md).
