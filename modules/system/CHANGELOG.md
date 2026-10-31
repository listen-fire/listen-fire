# @listen-fire/system

## 0.13.0

- New: `@lf/system`, the host itself as a source. One listenable `Events` edge, polled every minute by default, each event an `Event` whose `Kind` is one of `Run Failed`, `Run Paused`, `Validation Issue`, `Deprecated Version`, `Release Applied` and `Wait Lost Its Record`. A listen narrows it by `Kind`, which the module takes. Each event about a run is `notFor` that run's own listen, and `about` the run, so the host's loop breaker caps a chain of failure handlers. listen-fire hands it its facts over the records door (`systemModule`); another host hands in its own (`systemModuleWith`). A 0.12 `listen to sys { events: [...] }` upgrades to `e.Kind IN [...]`, and one naming no events to `e.Kind == "Run Failed"`.
