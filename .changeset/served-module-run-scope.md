---
"@listen-fire/module-kit": patch
"@listen-fire/module-runtime": patch
"@listen-fire/engine": patch
---

A module served by `serve-module` keeps a run's read memo and call ceiling, as it does in process. Each call is answered inside the run scope its `cacheScopeId` names: the calls of one run share it, two runs never do, and a call under `<none>` or `<slot>` (a host's own reads, a slot's calls) is answered outside any run.

- The protocol has no message that says a run has ended. A scope is let go after 10 minutes with no call, or when the process keeps 64 and another run arrives (the least recently used goes).
- The run scope (the read memo and the call ceiling) moved from the engine to `@listen-fire/module-runtime`, which the kit and the engine both stand on. The engine's segment opens it around every in-process adapter call as before; its exports are unchanged.
- Under `lf`, the Affinity module's `AFFINITY_MAX_CALLS_PER_RUN` now counts, per adapter instance per run segment, as it does in process.
