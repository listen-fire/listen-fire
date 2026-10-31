---
"@listen-fire/embed": patch
---

A `tick` never forgets an arrival a run that is starting is about to read. A run the host starts takes no lease, so each step now holds the arrival mark it took as it began until it ends, and the sweep keeps every arrival above the lowest mark held.
