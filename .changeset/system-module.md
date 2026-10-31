---
"@listen-fire/system": minor
---

`@lf/system`, a new module: the host itself as a source. One listenable `Events` edge, polled, whose `Event` a listen narrows by `Kind` (`Run Failed`, `Run Paused`, `Validation Issue`, `Deprecated Version`, `Release Applied`, `Wait Lost Its Record`), which the module takes. Each event about a run is `notFor` that run's own listen and `about` the run, so a host's loop breaker caps a chain of failure handlers. listen-fire hands it its facts over the records door (`systemModule`); another host hands in its own (`systemModuleWith`). See docs/contracts/system-events.md.
