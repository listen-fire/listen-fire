---
"@listen-fire/embed": minor
---

A wait the engine opens names the record it waits on: `OpenWait` gains `record_id` (`park.waits.open`'s `recordId`), so a store an embedder supplies can keep it with the wait. A store that answers stranded waits answers it as `recordId`.
