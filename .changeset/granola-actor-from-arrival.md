---
"@listen-fire/granola": patch
---

A run a Granola meeting fires reads the meeting's owner as its actor again (`@actor_email`, `@actor_name`): the module reads it from the meeting that arrived, where 0.13.0 read the 0.12 event's payload, which a 0.13 run is never handed, and answered no actor.
