---
"@listen-fire/embed": patch
---

`tick` first forgets the arrivals logged more than an hour before it that no run awaits (the run host's `sweepArrivals`), so the log does not grow without end and an arrival no run awaits is kept for the hour the docs say, not for ever.
