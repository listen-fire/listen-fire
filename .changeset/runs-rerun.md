---
"@listen-fire/engine": patch
---

`lf runs rerun <run-id>` runs a failed run again as the same run's next attempt: with the event (or manual text) it ran on, against the movement as the project holds it now, from the start. `lf runs show` lists every attempt with its status, times, writes and error; the run's status is its latest attempt's. Only a run whose latest attempt failed is rerun: a succeeded, running or parked run is refused by name, so a second rerun after one that succeeded runs nothing. A failed attempt that committed writes before it failed is refused unless `--force`, and the refusal lists those writes. A failed run now keeps the writes it made in its outcome (they used to be dropped when it failed). The store slot adds `runs.rerun`, and a run row may answer `attempt` and `attempts`.
