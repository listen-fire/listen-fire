---
"@listen-fire/module-kit": patch
---

An arrival a module reports `gone` (its record deleted) wakes no wait under listen-fire 0.13: the store logs it, but `waits.log` answers no wait for it and `parks.commitSegment` queues no `wake_await` for a wait whose record is gone. A wait whose record is deleted keeps waiting; a `race` with a `sleep` is the way out. A module keeps reporting `gone` as before.
