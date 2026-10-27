# The store slot's methods

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

A store module keeps a host's run state: runs, parks, joins, await correlations, leases, the work queue, library sources, callbacks, pull cursors and event receipts. lf ships two (`@lf/sqlite-store`, the default, and `@lf/postgres-store`). A third-party one is a module lf starts, or reaches at its URL, and calls over adapter protocol 2's HTTP, as it calls any module.

## Installing one

A folder in the project's externals folder, with an `lf-external.yaml`:

```yaml
name: acme_store
kind: core
slot: store
command: [node, store.mjs]      # started in this folder; or `url:` for a remote one
settings:                       # optional; prompted by `lf connect acme_store`
  - { name: path, label: the state file, secret: false, optional: false }
env: { LOG_LEVEL: info }        # optional
```

- lf.yaml names it for the slot: `core: { store: acme_store }`.
- `lf connect acme_store` asks its settings, keeps them on its install entry in the secrets file, and opens it once (so a module that sets itself up, a schema say, does so then).
- Every slot takes such a module ([the transport](adapter-protocol.md#transport)): the models, judge, files and browser slots' methods are [models-slot.md](models-slot.md), [judge-slot.md](judge-slot.md), [files-slot.md](files-slot.md) and [browser-slot.md](browser-slot.md).

## The envelope

The adapter protocol's ([the envelope](adapter-protocol.md#the-envelope), [the transport](adapter-protocol.md#transport)): one `POST` per method, the method in the body, the install's settings in `settings` on every request.

- A method's `params` is one object, keyed in camel case. Its `result` is the answer; `null` for a method that answers nothing.
- An absent optional string is `null`.
- Instants are `Date.toISOString` strings; ids and tokens are strings the module mints.
- A failure is `ok: false` with an `error`. The code `run_lease_lost`, with `data: { runId }`, means a fenced write found the run's lease gone: lf treats it as losing the run. Any other code is a store failure.
- lf calls a store one method at a time and waits for each answer.
- A write that must not be torn by a crash is one method, which the store keeps as one transaction: all of it or none (`parks.commit`, `events.startRun`, `inbound.keepDelivery`, and `callbacks.record` with its body's row). A remote store cannot hold a transaction open across requests, so there is no method that opens one.
- `inbound.keepDelivery` is also where a redelivery is kept out: its receipt is written first, unique on the subscription and the provider's delivery id, so a second delivery under that id, even one arriving while the first's work is still queued, writes nothing and answers `kept: false`.

## Methods

The first request is always `store.open`. The others are the run host's store families (`RunHostStore`, `CallbackStore` in `packages/movement-engine/services/run_host/`), method for method. Their meaning is the contract suite's: [`contract.ts`](../../packages/movement-engine/services/run_host/contract.ts) holds every store to the same cases, and `apps/cli` runs it through a store module (`run_host_contract.test.ts`).

| method | params | result |
|---|---|---|
| `store.open` | `{ settings: { [name]: string } }` | `{ tenant }`: the team id lf's own runs are kept under |
| `runs.start` | `{ id, file, movement, startedAt, input, deliveryId? }`; `deliveryId` names the delivery whose event started the run | `null` |
| `runs.status` | `{ runId }` | the run's status, or `"missing"`: a contract suite helper, not called by lf |
| `runs.complete` | `{ runId }` | `null`. The run settled `completed`: a contract suite helper, not called by lf |
| `runs.lapsed` | `{ staleMs, limit }` | the ids of runs still `running` whose lease lapsed or was never taken, started more than `staleMs` ago, oldest first: their worker is gone (a live first firing holds its lease and renews it every third of its length) |
| `runs.settle` | `{ runId, status, outcome, at }`; status `completed`, `parked`, `running` or `failed`; an ending revokes the run's live callbacks | `null` |
| `runs.markParked` | `{ runId }` | `null` |
| `runs.rerun` | `{ runId, input, at, fence }` | `{ attempt }`: the run's next attempt's number; `null`, and nothing written, when the run's status is not `failed`. One write, fenced as `parks.commit` is (a lost fence is `run_lease_lost`): the run's latest attempt is kept on its row as `{ attempt, status, startedAt, finishedAt, outcome }` (`outcome` the JSON object it settled with) at the end of `attempts`; the row's `attempt` goes up by one; and the run is `running` again, with `input` as its input, `at` as its `startedAt`, no `finishedAt` or outcome, no cancel request, and its spend baseline moved to what it has spent (the cost cap counts the new attempt alone). lf calls it under the run's lease, for `lf runs rerun` |
| `runs.get` | `{ runId }` | a run row, or `null` |
| `runs.list` | `{ limit }` | run rows, most recent first |
| `runs.appendTrace` | `{ runId, segmentId, entries: [...] }` | `null` |
| `runs.traceLength` | `{ runId }` | integer |
| `runs.spent` | `{ runId }` | microdollars spent since the spend baseline |
| `runs.addSpend` | `{ runId, microdollars }` | `null` |
| `runs.resetSpendBaseline` | `{ runId }` | `null` |
| `runs.requestCancel` | `{ runId, reason }` | `null` |
| `records.cancelRequest` | `{ runId }` | `{ reason }`, or `null` when none was asked |
| `records.markFailed` | `{ runId, message }` | `null`. A `running` or `parked` run settles `failed` with `message` as its outcome's `error`; the writes its outcome lists (`writes`, `writeRecords`) stay |
| `records.closeRun` | `{ runId }` | `null`. The run is over: its live callbacks are revoked (`callbacks.revokeRun`) |
| `parks.putLeaf` | `{ runId, address, reason, wakeAt, state, fence }` | `null` |
| `parks.claimLeaf` | `{ runId, address, reason }` | `{ reason, state }`, or `null` |
| `parks.finishLeaf` | `{ runId, address, fence }` | `null` |
| `parks.leaves` | `{ runId, parkedOnly, reason, dueBy }` | `[{ address, reason, status, wakeAt }]` |
| `parks.deleteLeaves` | `{ runId, addresses }` | `null` |
| `parks.commit` | `{ runId, address, state, fence, park }`; `park` is `{ kind: "timer", wakeAt }`, `{ kind: "await", teamId, adapterType, correlationKey }` or `{ kind: "limit" }` | `null`. One fenced write: the leaf (`parks.putLeaf` with the kind as its reason); for a timer, the run's `resume_timer` row (key `resume_timer:<runId>`, payload `{ runId }`) armed at `wakeAt` as `work.enqueue` arms it; for an await, its correlation (`correlations.correlate`); for a limit, the address's correlation dropped; and the run marked parked (`runs.markParked`). A lost fence writes nothing (`run_lease_lost`) |
| `joins.recordJoin` | `{ runId, frameAddress, pending, fence }` | `null` |
| `joins.decrementJoin` | `{ runId, frameAddress, branchAddress, leafAddress }` | `{ closed }` |
| `joins.persistBranchExport` | `{ runId, frameAddress, branchAddress, branchIndex, exports }` | `null` |
| `joins.collectBranchExports` | `{ runId, frameAddress }` | `[{ branchAddress, branchIndex, exports }]` |
| `joins.hasPendingJoins` | `{ runId }` | boolean |
| `joins.frames` | `{ runId }` | frame addresses |
| `joins.deleteFrames` | `{ runId, frameAddresses }` | `null` |
| `correlations.correlate` | `{ runId, teamId, address, adapterType, correlationKey }` | `null` |
| `correlations.correlated` | `{ adapterType, teamId, correlationKey }` | `[{ runId, teamId, address }]` |
| `correlations.ofRun` | `{ runId, adapterType }` | `[{ runId, teamId, address, correlationKey }]` |
| `correlations.drop` | `{ runId, address }` | `null` |
| `correlations.dropRun` | `{ runId }` | `null` |
| `leases.claim` | `{ runId, ttlMs }` | `{ token }`, or `null` while another holds it |
| `leases.renew` | `{ runId, token, ttlMs }` | boolean |
| `leases.release` | `{ runId, token }` | `null` |
| `leases.dropRunState` | `{ runId, fence }` | boolean |
| `work.enqueue` | `{ kind, key, payload, dueAt, teamId }` | `null` |
| `work.enqueueIfAbsent` | `{ kind, key, payload, dueAt, teamId }` | boolean: whether it was queued. One write: the row is inserted only when no row has the key; a row there in any state (due, leased, dead) is left as it is, its due time and payload untouched. lf arms a polled listen's standing row with it, so several workers arming it at once queue it once and never move the due time of a row another holds |
| `work.claimDue` | `{ limit, leaseMs, dueBy, kinds? }`; `kinds` (a drain pool's) leases only rows of those kinds, absent every kind; a dead row is never claimed | `[{ id, kind, key, payload, claim, attempts }]`; `attempts` counts the row's claims, this one included, less those released `busy`, since it was queued or released `rescheduled` |
| `work.complete` | `{ id, claim }` | `null` |
| `work.release` | `{ id, claim, dueAt, why? }`; `why` is `failed` (the claim was an attempt; the default), `busy` (its run was held elsewhere: the attempt is given back) or `rescheduled` (done, and due again: the attempts start over) | `null` |
| `work.bury` | `{ id, claim, reason }` | `null`. The row gave up: kept with `reason`, unleased and never claimed again; unless it was re-armed since the claim, when it is only unleased. `work.enqueue` of its key brings it back, its attempts from nought |
| `sources.put` | `{ teamId, hash, source }` | `null` |
| `sources.get` | `{ teamId, hash }` | the source, or `null` |
| `callbacks.mint` | `{ teamId, runId, address, params, state, singleUse, expiresAt }` | `{ id }` |
| `callbacks.get` | `{ id }` | a callback row, or `null` |
| `callbacks.record` | `{ id, values, bodyDueAt }` | `{ kind: "recorded", callback, callIndex }`, or `{ kind: "not_found" }`, `{ kind: "closed", callback }`, `{ kind: "expired", callback }` |
| `callbacks.markBodyStarted` | `{ id, callIndex, fence }` | boolean |
| `callbacks.landed` | `{ ids }` | those of `ids` with at least one call whose body started |
| `callbacks.revokeRun` | `{ runId }` | `null` |
| `inbound.checkpoint` | `{ subscriptionId }` | `{ checkpoint }`, or `null` |
| `inbound.saveCheckpoint` | `{ subscriptionId, checkpoint }` | `null` |
| `inbound.keepDelivery` | `{ subscriptionId, checkpoint?, delivery: { id, externalId?, receivedAt, source, inline, replayOf?, events }, work: [{ kind, key, payload, dueAt, teamId }] }`; `source` is `webhook`, `hook`, `emit` or `cli`; `events` are the events the delivery produced, never its raw body | `{ kept }`. One write: the delivery's receipt first, then the cursor saved (absent: left as it is; `null` is a cursor to save) and each row queued as `work.enqueue` queues it. `kept: false`, and nothing written (no cursor, no rows), when a delivery with the same `externalId` was kept at the subscription before, or one with the same `id`. Without an `externalId` a delivery is never a duplicate |
| `inbound.forgetDeliveryId` | `{ id }` | `null`. Clears the kept delivery's `externalId`, its receipt kept: lf calls it when a delivery's events, run inside the request, failed and its sender was answered 500, so the sender's retry under that id is kept as a delivery of its own |
| `inbound.deliveries` | `{ subscriptionId?, since?, limit }`; `since`: received at or after it | delivery rows without their events, most recent first, at most `limit` |
| `inbound.delivery` | `{ id }` | a delivery row with its `events`, or `null` |
| `inbound.sweepDeliveries` | `{ before, limit }` | how many went. Forgets at most `limit` deliveries received before `before` whose runs are all settled (none `running` or `parked`) and that no `fire_event` work row names (its `payload.deliveryId`) |
| `processes.list` | `{}` | `{ processes, version }`: the module processes the hosts on this store started (an array of `{ pid, lf, machine, command }`), at its version; `{ processes: [], version: 0 }` for a list never written |
| `processes.swap` | `{ version, processes }` | `true` when the list was still at `version` and is now `processes` at `version + 1`; `false` when another host wrote first (read again and retry) |
| `events.claim` | `{ listen, key }` | `true` the first time this event key reaches this listen; `false` for a redelivery, which runs nothing |
| `events.startRun` | `{ listen, key, id, file, movement, startedAt, input, deliveryId? }` | `events.claim` and, when it is `true`, `runs.start`, as one write: `false`, and no run, for a redelivery |

The rows:

```ts
type RunRow = {
  id: string; file: string; movement: string; status: string; startedAt: string; finishedAt?: string | null;
  input: string; outcome: string | null; deliveryId: string | null;
  attempt?: number;      // the latest attempt's number; absent: 1
  attempts?: { attempt: number; status: string; startedAt: string; finishedAt: string | null; outcome: unknown }[];  // the earlier ones, oldest first
};
type DeliveryRow = {
  id: string; subscriptionId: string; externalId: string | null; receivedAt: string;
  source: 'webhook' | 'hook' | 'emit' | 'cli'; inline: boolean; replayOf: string | null;
  eventCount: number; runs: { id: string; status: string }[];
  events?: unknown[];  // inbound.delivery only
};
type CallbackRow = {
  id: string; teamId: string; runId: string; address: string;
  params: unknown; state: unknown; calls: unknown; singleUse: boolean;
  expiresAt: string | null; status: 'live' | 'fired' | 'revoked';
};
```

A run's `outcome` is the JSON object lf settled it with: `{ writes, writeRecords?, returned? }`, or `{ error, writes?, writeRecords? }` for a failed run, which keeps the writes it made before it failed. A run's `status`, `startedAt`, `finishedAt`, `input` and `outcome` are its latest attempt's. `writeRecords` lists the run's writes (`lf runs show`); a store that drops it still works with lf, and its runs list no writes. `finishedAt` is when the run settled completed or failed; a store that answers none leaves `lf runs` showing `null`. `returned` is what the movement returned, as lf records it (at most 64 KiB of JSON, a file by its reference). A store hands the outcome back as it was given (its members may be kept in columns of their own, as `@lf/postgres-store` keeps them). A store that drops `returned` still works with lf: its runs show no returned value.

`lf --contract-store <state.db|postgres://…>` serves these methods over lf's own stores, as a store module on a Unix socket. A module may forward to it, as the test module does (`apps/cli/src/__test__/store_module/forward.mjs`). `runs.status` and `runs.complete` are the contract suite's helpers and are not called by lf.

## Changes

- **2026-10-27, later** (within adapter protocol 2): `runs.rerun` starts a failed run's next attempt (`lf runs rerun`), and a run row may answer `attempt` and `attempts`. A failed run's outcome keeps the writes it made (`records.markFailed` and `runs.settle` with `failed` alike). A store that answers no `attempt` or `attempts` still works, its runs each one attempt; one without `runs.rerun` works for everything but `lf runs rerun`. `@lf/postgres-store` keeps them from its migration 8, and now keeps `writeRecords` as well.

- **2026-10-27** (within adapter protocol 2): a run row may answer `finishedAt`, and a run's settled `outcome` carries `writeRecords`. Both are optional: a store that answers neither still works, and its runs show no finish time and list no writes.
- **2026-10-22** (within adapter protocol 2; lf 0.12.0-rc.9 requires it): a delivery's receipt. `inbound.keepDelivery` takes the `delivery` (the events it produced) and answers `{ kept }`, `false` for a redelivery under the same `externalId` at the same subscription, which writes nothing. Every store module must take the new shape: lf treats a `null` answer as malformed. `inbound.deliveries`, `inbound.delivery` and `inbound.sweepDeliveries` list, read and forget kept deliveries, and `inbound.forgetDeliveryId` clears a kept delivery's `externalId`. `runs.start` and `events.startRun` take `deliveryId`, and a run row answers it. `runs.status`, `runs.complete` and `records.closeRun`, served all along, are now in the table.

- **2026-10-20** (within adapter protocol 2): a run's settled `outcome` may carry `returned`, what its movement returned. No method changed: a store that hands the outcome back as it was given keeps it.
- **2026-10-20** (within adapter protocol 2): a crash never tears lf's state. `parks.commit`, `events.startRun` and `inbound.keepDelivery` each keep in one write what lf wrote in several; `runs.lapsed` finds the runs whose worker was lost, which lf fails; `work.claimDue`'s rows carry `attempts`, `work.release` says `why`, and `work.bury` keeps a row that gave up dead, so a failing row is no longer retried forever.

- **2026-10-19** (within adapter protocol 2): `processes.list` and `processes.swap`, the list of module processes the hosts on a store started, written by compare-and-set on its version so two lfs on one store never overwrite each other's entries. lf used to keep it in an inbound checkpoint row.
- **2026-10-19** (within adapter protocol 2): the methods ride adapter protocol 2's HTTP, as every module's do; the stdin/stdout JSON-RPC wire is retired. A lost lease is the error code `run_lease_lost` (`data: { runId }`). A store module may be remote (`url:`).
- **2026-10-18** (within adapter protocol 2): `work.claimDue` takes `kinds`, for drain pools (`lf drain --kinds`).
- **2026-10-17** (within adapter protocol 2): the store slot's wire, and process modules filling the store slot.
