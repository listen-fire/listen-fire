# @listen-fire/module-kit

## 0.12.7

### Patch Changes

- 216a7a4: A module served by `serve-module` keeps a run's read memo and call ceiling, as it does in process. Each call is answered inside the run scope its `cacheScopeId` names: the calls of one run share it, two runs never do, and a call under `<none>` or `<slot>` (a host's own reads, a slot's calls) is answered outside any run.
  
  - The protocol has no message that says a run has ended. A scope is let go after 10 minutes with no call, or when the process keeps 64 and another run arrives (the least recently used goes).
  - The run scope (the read memo and the call ceiling) moved from the engine to `@listen-fire/module-runtime`, which the kit and the engine both stand on. The engine's segment opens it around every in-process adapter call as before; its exports are unchanged.
  - Under `lf`, the Affinity module's `AFFINITY_MAX_CALLS_PER_RUN` now counts, per adapter instance per run segment, as it does in process.
  - `serve-module` says so on stderr, once at start, when the process holds more than one copy of `module-runtime`'s run scope: a module on a different copy than the kit's would silently have no run cache or call ceiling.

## 0.12.6

### Patch Changes

- A served module's manifest states the adapter protocol minor it uses (`protocolMinor`), computed from the features the manifest uses. Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
