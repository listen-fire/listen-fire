---
"@listen-fire/system": minor
---

`Arrival Not Judged` names its attempt: the `Event Id` is `arrival_not_judged:<listen>:<arrival>:<attempt>`, 0 for the arrival's first judging and one more for each `listen-fire listens replay` that still cannot judge it, so each failed attempt is reported once. `UnjudgedArrival` and its cursor mark carry `attempt`; a host that sends none is read as attempt 0 (docs/contracts/system-events.md).
