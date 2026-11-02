# The loop guard slot's methods

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

A loop guard module is told of each record write a run makes, with the record as the write left it. listen-fire asks it nothing back.

**The slot is empty by default.** listen-fire ships one guard, `@lf/fingerprint-guard`. A guard whose memory is elsewhere (Redis, a database) is a third-party module listen-fire starts (or reaches at its URL) and calls over adapter protocol 2.

The guard is operator configuration, not language. A movement that writes to a source it listens to hears its own write come back (Attio sends `record.updated` for the update a run just made, a poll returns the row a run just changed), and listen-fire's loop breaker, not the guard, caps every chain of writes and arrivals: an arrival on a record a run wrote within `lf.yaml`'s `loopWindow` (default 20s) continues that run's chain, and the listen whose arrival would make a chain longer than `loopDepth` (default 10) runs is paused, `LISTEN_LOOP`, until `listen-fire listens resume` ([the store's write ledger](store-slot.md), `writes.record`). A write that would change nothing is never sent where the module lists `readRecord`, so a two-way sync's echo writes nothing and its chain ends.

## Using one

```yaml
core:
  loopGuard: "@lf/fingerprint-guard"
```

- The host's part is one moment. After a run writes a record to a source that sends webhooks or is polled, and can read a record back (`readRecord`), the host reads the record back and tells the guard (`guard.recordWrite`). A source that cannot read a record back, or a failed read, tells the guard nothing.
- Everything else is the guard's: what it keeps, for how long, and where.
- `@lf/fingerprint-guard` remembers a hash of the record as the write left it, for an hour, per record and writing movement. Its settings (all optional): `path` (its file, default `.lf/guard.db`) and `url` (a Postgres database every listen-fire worker shares, in its own `lf_guard` schema, created when the guard is set up or opened). The store slot knows nothing of it.
- Installing a module of your own: a folder in the externals folder with an `lf-external.yaml` saying `kind: core`, `slot: loopGuard` and its `command`, as [the limiter's](limiter-slot.md#installing-one). `listen-fire connect <module>` asks its settings and opens it once.

## The envelope

The store slot's envelope ([store-slot.md](store-slot.md#the-envelope)): adapter protocol 2's HTTP, one request at a time.

## Methods

| method | params | result |
|---|---|---|
| `guard.open` | `{ settings: { [name]: string } }` | `null` |
| `guard.recordWrite` | `{ adapter, recordType, externalId, writer, record }` | `null` |

- **`recordWrite`**: `writer` (`listen:<file>:<movement>`) wrote the record `externalId` of `adapter`; `record` is what the source answered when read back right after (`null`: the record is gone). The same writer's later write to the same record replaces the earlier.
- A guard that still offers `guard.isEcho` (one built for listen-fire 0.13) loads as before: listen-fire never calls it.

## The contract suite

[`contract.ts`](../../packages/movement-engine/services/loop_guard/contract.ts) holds every guard to the same cases: each takes the writes it is told of. `apps/cli` runs it over `listen-fire --contract-guard` (listen-fire's built-in, file and Postgres) and `listen-fire --contract-guard-slot` (a test module filling a project's slot, `apps/cli/src/__test__/loop_guard_module/serve.ts`); the in-process TypeScript one passes it in `services/loop_guard/__test__`. The platform defines the same slot (`loopGuard` in `CORE_SLOTS`), default empty.

## Changes

- **Unreleased** (within adapter protocol 2): `guard.isEcho` is retired from the slot. listen-fire's built-in no longer answers it (`method_not_implemented`), and the contract suite no longer holds a guard to it. Why: listen-fire stopped calling it in 0.13, and the loop breaker caps every chain. No version moves: a host that stops calling a method changes nothing for a module, and a guard that still offers it loads and is never asked.
- **2026-11-01** (listen-fire 0.13.0): listen-fire never calls `guard.isEcho`, so a configured guard no longer suppresses an echo; it still calls `guard.recordWrite`. Why: a listen is a traversal judged by the engine's one judge, and the loop breaker caps every chain on every host; the guard's per-host echo check had no caller left. The slot is retired in a later release.
- **2026-10-31** (listen-fire 0.13.0): `suppress_self` is gone from the language; the guard is unchanged. listen-fire's loop breaker caps every chain of writes and arrivals, guard or none.
- **2026-10-19** (within adapter protocol 2): the methods ride adapter protocol 2's HTTP; the stdin/stdout JSON-RPC wire is retired.
- **2026-10-18** (within adapter protocol 2): the loop guard slot, its wire, and process modules filling it.
