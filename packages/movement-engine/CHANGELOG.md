# @listen-fire/engine

## 0.12.8

### Patch Changes

- 7cd7476: Adapter protocol 2.3: a polled source labels each event with its kind (`eventType`), as a pushed event is, and `lf` narrows a polled listen's `events` by it. A poll event with no label (a module older than 2.3) still reaches the listen that polled it, and `lf` says so once per module per process. `PROTOCOL_MINOR` is 3; 2.3 is a rule for sources and a host behaviour, so no module states it. A poll's `movementId` is the listen's pipeline, `listen:<file>:<movement>`. `LF_SECRET__<ENTRY>__MODULE=<module>` makes an entry from the environment that module's install, as `module:` does in the secrets file.

## 0.12.7

### Patch Changes

- 7b8a778: A hop whose WHERE pins a type's discriminant with a literal (`` `listName` == "Master Deals List" `` on an Affinity record's `List Entries`) lands on the member that value picks, taken from the write shape's `discriminated` variants the catalog already carries. The checker types the hop's body and the WHERE's other conjuncts by that member, and the engine drops a landed record of another member before reading its fields. A host's own narrowing (`refinements` / `selectedMembers`) answers first, as before.
- 216a7a4: A module served by `serve-module` keeps a run's read memo and call ceiling, as it does in process. Each call is answered inside the run scope its `cacheScopeId` names: the calls of one run share it, two runs never do, and a call under `<none>` or `<slot>` (a host's own reads, a slot's calls) is answered outside any run.
  
  - The protocol has no message that says a run has ended. A scope is let go after 10 minutes with no call, or when the process keeps 64 and another run arrives (the least recently used goes).
  - The run scope (the read memo and the call ceiling) moved from the engine to `@listen-fire/module-runtime`, which the kit and the engine both stand on. The engine's segment opens it around every in-process adapter call as before; its exports are unchanged.
  - Under `lf`, the Affinity module's `AFFINITY_MAX_CALLS_PER_RUN` now counts, per adapter instance per run segment, as it does in process.
  - `serve-module` says so on stderr, once at start, when the process holds more than one copy of `module-runtime`'s run scope: a module on a different copy than the kit's would silently have no run cache or call ceiling.

## 0.12.6

### Patch Changes

- Adapter protocol 2.N: a module states the protocol minor it uses (`protocolMinor` on its manifest), and lf and the engine speak 2.0–2.2 and refuse a module outside that range by name. lf checks a slot module's protocol at start, so a slot module must answer `manifest` before anything else.
