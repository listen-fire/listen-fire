# @listen-fire/engine

## 0.12.9

### Patch Changes

- 510d923: `lf connect` sets up an OAuth app only when it is needed: a module whose users may also sign in otherwise (a token: `@lf/attio`'s `attio_token`, `@lf/mcp`'s `mcp_token`) is asked whether to (no by default), and `--yes` sets none up unless `--oauth-authorize-url`/`--oauth-token-url` are given. Adding that module's OAuth credential without an app is refused, naming how to set one up.
- 783f329: `lf` describes an adapter once per connection: each credential bound to the module that the movement files import is asked `listEntryPoints` and `describe` as itself (one bound but never imported is not asked), and each connection is typed by its own answer, as the hosted product types it. Before, every connection of a module was typed by the first credential's answer, so a call another connection's schema allowed could pass `lf check`.
- f15adc8: Under `lf`, two connections of one module (`a = connect attio using AttioA`, `b = connect attio using AttioB`) no longer share inbound events. A delivery to a connection's door (`/api/public/webhook-sync/<provider>/<credential>`, `/hooks/<external>/<credential>`) runs only the listens whose construction names that credential, and listens whose construction names none. A delivery to the module's own install still reaches every listen. `lf serve` registers a webhook per connection, as that connection's credential, for that connection's listens' events; a credential no listen uses has its webhook removed. A polled listen polls as its own connection's credential. A queued event row from before this release reaches every listen, as it did.

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
