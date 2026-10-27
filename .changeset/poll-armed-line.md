---
"@listen-fire/engine": patch
---

`lf` says when a polled listen's first poll sets its mark and fires nothing, as Gmail's does: `gmail: inbox:invoice armed; it fires on changes from now` (under `lf serve` and `lf drain` as an `lf:` line). Before, nothing was printed until the first run, so a live listen looked like a dead one.
