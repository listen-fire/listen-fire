# The loop guard slot's methods

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

**The slot is retired.** listen-fire starts no guard: a project whose `lf.yaml` still names one in `core:` runs as before, with one notice naming it as listen-fire starts, and no `guard.*` method is called. listen-fire's loop breaker caps every chain of writes and arrivals instead: an arrival on a record a run wrote within `lf.yaml`'s `loopWindow` (default 20s) continues that run's chain, and the listen whose arrival would make a chain longer than `loopDepth` (default 10) runs is paused, `LISTEN_LOOP`, until `listen-fire listens resume` ([the store's write ledger](store-slot.md), `writes.record`). Remove `core.loopGuard` from `lf.yaml`: 0.14.0 refuses it.

The methods below are what a guard module answered. The contract suite still holds `@lf/fingerprint-guard` and a test module to them until 0.14.0 removes the slot.

## The envelope

The store slot's envelope ([store-slot.md](store-slot.md#the-envelope)): adapter protocol 2's HTTP, one request at a time.

## Methods

| method | params | result |
|---|---|---|
| `guard.open` | `{ settings: { [name]: string } }` | `null` |
| `guard.recordWrite` | `{ adapter, recordType, externalId, writer, record }` | `null` |

- **`recordWrite`**: `writer` (`listen:<file>:<movement>`) wrote the record `externalId` of `adapter`; `record` is what the source answered when read back right after (`null`: the record is gone). The same writer's later write to the same record replaces the earlier.

## The contract suite

[`contract.ts`](../../packages/movement-engine/services/loop_guard/contract.ts) holds every guard to the same cases: each takes the writes it is told of. `apps/cli` runs it over `listen-fire --contract-guard` (listen-fire's built-in, file and Postgres) and `listen-fire --contract-guard-slot` (a test module filling a project's slot, `apps/cli/src/__test__/loop_guard_module/serve.ts`); the in-process TypeScript one passes it in `services/loop_guard/__test__`. The platform defines the same slot (`loopGuard` in `CORE_SLOTS`), default empty.

## Changes

- **Unreleased** (within adapter protocol 2): the slot is retired. listen-fire starts no guard and calls no `guard.*` method; a configured `core.loopGuard` gets one notice as listen-fire starts. Why: once `guard.isEcho` was retired nothing read what a guard remembered, and the loop breaker caps every chain. 0.14.0 refuses a configured guard and removes the slot.
- **Unreleased** (within adapter protocol 2): `guard.isEcho` is retired from the slot. listen-fire's built-in no longer answers it (`method_not_implemented`), and the contract suite no longer holds a guard to it. Why: listen-fire stopped calling it in 0.13, and the loop breaker caps every chain. No version moves: a host that stops calling a method changes nothing for a module, and a guard that still offers it loads and is never asked.
- **2026-11-01** (listen-fire 0.13.0): listen-fire never calls `guard.isEcho`, so a configured guard no longer suppresses an echo; it still calls `guard.recordWrite`. Why: a listen is a traversal judged by the engine's one judge, and the loop breaker caps every chain on every host; the guard's per-host echo check had no caller left. The slot is retired in a later release.
- **2026-10-31** (listen-fire 0.13.0): `suppress_self` is gone from the language; the guard is unchanged. listen-fire's loop breaker caps every chain of writes and arrivals, guard or none.
- **2026-10-19** (within adapter protocol 2): the methods ride adapter protocol 2's HTTP; the stdin/stdout JSON-RPC wire is retired.
- **2026-10-18** (within adapter protocol 2): the loop guard slot, its wire, and process modules filling it.
