---
"@listen-fire/embed": minor
---

The run host's store (`runHost`) serves stranded waits (docs/contracts/stranded-waits.md): `waits.log` answers `{ wakes, stranded }`, a gone arrival stranding each wait parked on its record; `waits.open` takes a `null` key, for a record already gone, and a park on such a wait strands it; `waits.arrivals` answers no `gone`; and `waits.stranded` answers one run's stranded waits, or every run's a page at a time. A store an embedder supplies implements them; the in-memory store does. It needs `@listen-fire/engine` 0.13.0.
