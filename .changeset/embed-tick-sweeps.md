---
"@listen-fire/embed": patch
---

`tick` first forgets the arrivals no run awaits (the run host's `sweepArrivals`), so the log does not grow without end. Each arrival's identity is kept for its module's re-send window (`resendWindowSeconds`, an hour when the module declares none), so a re-send of an arrival already forgotten is still a repeat that wakes nothing.
