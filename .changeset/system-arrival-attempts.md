---
"@listen-fire/system": minor
---

`Arrival Not Judged` names its attempt: the new `Attempt` field (a number, 0 on every other kind) is 0 for the arrival's first judging and one more for each `listen-fire listens replay` that still cannot judge it, and the `Event Id` is `arrival_not_judged:<listen>:<arrival>:<attempt>`, so each failed attempt is reported once. `UnjudgedArrival` and its cursor mark carry `attempt`; a host that sends none is read as attempt 0. An arrival that is itself an `Arrival Not Judged` event is never reported in turn (the module logs it), so two listens on `Events` cannot report each other without end (docs/contracts/system-events.md).
