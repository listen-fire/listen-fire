# What lf-platform adopts for 0.13

Every change 0.13 asks of a host other than `listen-fire`, in one list. Each
item says what to change and links the contract that holds the detail; the
contract, not this list, is the reference. The CHANGELOG's 0.13.0 section
says why each change was made.

## The store slot

The hosted store serves the methods `listen-fire` calls on a store module
([store-slot.md](store-slot.md), "Changes", the 0.13.0 entries).

- **Methods to serve.**
  - `waits.mark`, `waits.log`, `waits.open`, `waits.arrivals`, `waits.note`, `waits.sweep`, `waits.stranded`, and `parks.commit` with `{ kind: "wait", waitId }`.
  - `parks.commitSegment`: a resumed stretch's joins, parks, settle and owed races in one write; and `parks.owedRaces`.
  - The `waits` rows keep their `leaf`, and `waits.log` queues its wakes in its own write.
  - Logging an arrival and parking a wait on the same record take one per-record lock, so neither misses the other.
  - Parking takes a team id.
  - `writes.record` and `writes.depth`: the loop breaker's ledger.
  - `listens.states`, `listens.claimResolve`, `listens.saveResolution`, `listens.setPaused` and `listens.hold`.
  - `unjudged.note` (with `attempt`) and `unjudged.list` (with `pipeline`).
  - `work.completeKey`: a row its caller ran itself, deleted unless a live claim holds it; completing a `fire_event` row drops the waits its delivery opened for runs that never started.
  - `inbound.delivery`: a kept delivery with its events and its request.
  - `inbound.sweepDeliveries`: forgets the settled deliveries received before a time, and the request of every delivery that old.
  - `runs.failed`, `releases.note` and `releases.list`, which the records door reads ([system-events.md](system-events.md#the-records-door)).
  - `callbacks.*`, `correlations.*` and `records.closeRun` are no longer called.
- **Migrations.** `@lf/postgres-store` migrations 10 to 16 are 0.13's.
  - 10 drops the callback and correlation tables: a run parked on a callback under 0.12 cannot resume.
  - 13 was amended on this branch before release: a delivery's `source` may be `poll`. A database that applied an earlier branch build of 13 lacks it.
  - 15 serves the records door (failed runs, releases) and a wait's `recordId`; 16 keeps the unjudged arrivals.
- **A wait on a record already gone.** `waits.open`'s `key` may be `null` (or absent), for a record gone before the run waited on it. A store that requires a key fails such a run.
- **The re-send window.** `waits.log`, and `inbound.keepDelivery`'s `arrivals`, take `resendWindowMs`. The store keeps each arrival's identity apart from its log entry for that window, so a re-send after the sweep forgot the entry is still a repeat.
- **Waits outlive a deleted run.** Migration 13 drops the foreign key from waits to runs. A wait its run opened is live while the run exists, so a host whose retention deletes run rows deletes their waits with them; otherwise each pins the arrival sweep for its record.
- **The sweep floor.** `waits.sweep({ limit, floor? })` forgets an arrival only at or below the floor: the lowest mark an unexpired lease kept, never above the caller's `floor`. A wait is live while its run exists, or while its queued `fire_event` row is not buried; that row's `arrivalMark` counts toward the floor. `leases.claim` keeps the mark in its own write.
- **`inbound.keepDelivery`.** One write keeps the receipt, its arrivals, a work row and the trigger waits for each run it starts, and the cursor of a poll. It answers `{ kept: false }` for a redelivery, else `{ kept: true, arrivalMark, wakes? }`. A gone arrival wakes no wait.
  - It may carry `unjudged`, the listens that could not judge the delivery's arrivals, kept in the same write as `unjudged.note` keeps each: a poll moves its cursor and keeps those facts together.
  - Each `fire_event` row it queues carries its delivery's `arrivalMark` in its payload; `conformance/store-waits.json`'s `claimRow` step checks it.
- **Receipts by team.** `runs.start`, `events.claim` and `events.startRun` take `teamId`, as `waits.*`, `work.enqueue` and `parks.commitSegment` do. A receipt is its team's: the same listen and key under another team is another receipt. Tenant reads (`runs.get`, settle) must be scoped by team too.
- **`Arrival Not Judged` facts.** Keep one wherever the host's judge answers `{ undecided }`: once per listen, arrival and attempt, with the listen's pipeline, the delivery, the arrival's receipt key, edge, record, reason, the causing run, the time and the attempt ([system-events.md](system-events.md#arrival-not-judged)).
- **Captured requests.** Keep each delivery's request beside its receipt: its body and query string without the fields its module names in `inbound.redactFields`, only the headers its module names in `inbound.captureHeaders` (a header whose name holds `authorization`, `cookie`, `signature`, `secret`, `token`, `key`, `auth`, `hmac` or `password` is refused), and the ids of the arrivals it brought. The body is otherwise kept as received, so it may hold whatever the provider puts in it. Keep it for the delivery's retention and show it only to a person who asks ([adapter-protocol.md](adapter-protocol.md#declared-inbound-signatures)).

## Adapter protocol 2.6

The host speaks 2.0 to 2.6 ([adapter-protocol.md](adapter-protocol.md#minors-of-version-2), the 2.6 row).

- **Arrivals.** A root arrival names no `key`. Pass through each arrival's members ([Reporting arrivals](adapter-protocol.md#reporting-arrivals)):
  - `landing` and each of `parents`, each with its `recordType` and `unknown` fields;
  - `notFor`, a listen's pipeline it must not run;
  - `occurredAt`, `about` and `takenApplied`.
  - An arrival whose landing or parent states no `recordType` is undecided, and runs nothing.
  - A skip may carry a `reason` (the judge's `{ skips, reason? }`): a record of another type says so, where a `WHERE` that fails gives none.
- **Describe refusals.** Refuse a module whose one listenable edge name lands on the same record type from two record types: its arrivals could not be told apart. Refuse `delivery: scope` on a root collection, and an `identity` or `version` naming a field the landing lacks.
- **Minor 6.** A module that uses any 2.6 member states `protocolMinor: 6` (a root arrival, `unknown`, `recordType`, `captureHeaders`, `redactFields`); every bundled module does.
- **`AwaitHead.recordType`.** Pass each head's record type to `awaitKeys`. Affinity refuses a head without one.
- **`checkInbound`'s `replayed`.** Set it only from the host's own replay entry point; strip it from anything a sender supplies.
- **Polls.** A polled listenable edge is polled as `poll({ edge, filter?, scope?, cursor? }) → { arrivals, cursor? }`, once per connection, edge, taken filter and scope ([Polled sources](adapter-protocol.md#polled-sources-and-periodic-tasks)). The first poll only arms, and so does a listen that joins a poll with no cursor later. The settings poll (`{ config, checkpoint }`) and its `poll_listen` work rows are gone; refuse a `{ events, checkpoint }` answer.
- **Subscriptions.** A pushed edge is subscribed for as `ensureEventSubscription({ edge, filter?, scope?, callbackUrl, current? })`; `removeEventSubscription` and `refreshEventSubscription` name the same `edge`, `filter` and `scope` ([Subscribing for an edge's arrivals](adapter-protocol.md#subscribing-for-an-edges-arrivals)). The events form is gone: remove a webhook a 0.12 listen registered (`removeEventSubscription`'s 0.12 form) rather than renewing it, and retry a failed registration on the host's own schedule.
- **`scopedBy`.** An edge pushed per scope may name the earlier hop it is subscribed per (Airtable's `Changes` by `Bases`): subscribe once per record that hop landed on.
- **Declarations to project.** Carry what a module now declares into the catalog: `membersChange` (`"pushed"` or `{ relistEverySeconds }`, where three members were), `owned.format` (`cron` or `timeZone`), a field's `changedIn` (projected as the position's `changedFields`), and a `listenSettingsBecome` mapping's `changed`, `alsoArrivesOn` and `null` values ([catalog-snapshot.md](catalog-snapshot.md#changes)).
- **Redacted request fields.** A kept request drops the body and query fields `inbound.redactFields` names ([Declared inbound signatures](adapter-protocol.md#declared-inbound-signatures)).
- **Webhook doors.** Keep each tenant connection's door URL its own (public base, adapter, credential, scope). A module that holds no webhook deletes every webhook at its door, so a shared door lets one tenant delete another's.

## Hosts

- **One judge.** Decide every arrival with the engine's judge, reached through the wasm (`listenFires`, `judgeArrival` in `@listen-fire/engine/public/inbound`). Both hosts are held to `engine-contracts/conformance/listen-arrivals.json`.
- **Fields by name.** The catalog projection emits each position's `fieldIds` (name to id, where they differ), and the host reads every record an arrival carries by those names before judging it (`namedFields`; `conformance/listen-field-names.json`). Without it an email listen reading `Subject` never fires.
- **Taken comparisons.** A module that applies the taken part of a filter itself (`takenApplied`) decides each comparison as the judge does (`conformance/taken-comparisons.json`, which the engine and module-kit both run).
- **Catalog cache.** Key a cached catalog by the release that built it: one built before `fieldIds` maps no field, and its email listens stay silent until it is rebuilt.
- **Pipeline ids.** Name a listen as `listen-fire` does, `listen:<file>:<movement>:<digest>` (`listenPipeline`; `conformance/listen-pipelines.json`). `notFor` and the receipts key on it.
- **Dispatch.** `@listen-fire/embed` takes a delivery as one call, `dispatch(tenant, { adapterType, connection?, arrivals })`, kept in one store write; `arrive` is gone. `SavedProgram.listens` holds each listen's plan.
  - It answers `{ runs, notJudged }`: each arrival a listen could not judge, with the listen's pipeline, the arrival, the reason and the delivery. Keep those as `Arrival Not Judged` facts.
  - It throws, naming why, for a delivery it cannot route: a module the host lacks, a connection the tenant does not hold, an arrival that does not parse, or a keyless arrival on an edge that is no root.
  - It clears the waits of a run that ends in its first segment, and abandons those of one that fails there, as `listen-fire` does.
- **Rust embedding.** `embed::listens(source, &catalog, version)` answers each listen's plan, and `Listen::judge(&arrival, now_ms)` decides an arrival by it; route by the plan, never by the edge alone.
- **Loop guard.** `listen-fire` 0.13 never calls `guard.isEcho`; it still calls `guard.recordWrite`. A host that asked the guard stops: the loop breaker replaces it ([loop-guard-slot.md](loop-guard-slot.md)).
- **Loop breaker.** Record each write a run sends (`writes.record`) and continue that run's chain when an arrival lands on a record it wrote within the loop window (`writes.depth`). The embedded host has none yet.
- **Re-resolution is listen-fire's.** A listen whose earlier hop has a `WHERE` the module's arrivals do not carry the record for is resolved by listing, which only `listen-fire` does. The embedded host refuses such a listen at save, by name.
- **Replay.** Offer a replay of one listen through a kept delivery, as `listen-fire listens replay` does: the request read again without verifying it, only the arrivals the delivery brought judged, by that listen alone, honouring its receipt unless forced, and a listen that still cannot judge it kept as the next attempt ([system-events.md](system-events.md#putting-the-arrival-through-the-listen-again)). `listen-fire deliveries replay`, which queued a delivery's events again, is retired: a replay is always through one listen.

## Modules

Each bundled module's 0.13 shape; a host that read their events reads `arrivals` now.

- **`@lf/system`.** One `Events` edge with a `Kind` field, where there was one edge per kind. The module takes `Kind` filters. New kinds: `Wait Lost Its Record` and `Arrival Not Judged` ([system-events.md](system-events.md#adopting-it-elsewhere), which lists what the host answers).
- **`@lf/email`.** Listened to on `Emails`, narrowed by `Key`, the plus-suffix lowercased. The routing-key form is gone: the manifest's `triggerConfig` with its slug block, and the automation-detail form a host rendered from it. On a shared box, refuse keyless listens or drop keyless mail at the door; otherwise `e.Key == ""` hears every team's mail.
- **`@lf/slack`.** A message's id is `channel:ts`, so the loop breaker matches it; a host keying linked objects on the bare `ts` must change. A message's `Timestamp` and a press's `At` have ids of their own (`timestamp`, `pressed_at`) holding the ISO time; the raw `ts` keys stay raw. It names its legacy `token` in `redactFields`. `preprocessInbound` answers `arrivals` and calls Slack (`auth.test`, `conversations.info`), so the door gives the module a credential then. `listEventTypes`, `slackInboundEvents` and the `channels` gate are gone.
- **`@lf/airtable`.** Listened to on a table's `Changes`: `Kind`, and `Current` and `Previous` rows read through as `record` fields. A table's changes are its own type (`Candidates Change`).
- **The ask module.** Its `Response` edge declares `listenable`, so a run awaits it.
- **The webhook door.** It accepts form-encoded bodies, as a module's inbound may be sent.
- **`@lf/telegram` and `@lf/whatsapp`.** `listEventTypes` and the inbound event parses are gone; the Meta door and the shared-bot classifier read `arrivals`.
- **Every module.** No module declares `subscribableEvents`, `defaultSubscribedEvents`, `listenConfig`, `subscriptionScopeKeys`, `triggerConfig`, or `fires` on an entry point. A describe that declares one is refused by name.

## Language

- **Record fields.** A schema field may be a `record` naming its position without its instance (`SchemaFieldType`'s `{ kind: 'record'; position }`). The platform's checker types it through the instance whose schema declares it, as a value, never as a record to walk or write.
- **`exists` narrowing.** A field is never read through a value that may be absent (`MOV_ABSENT_REQUIRED`); `exists(x)` narrows it.
- **Held-record type.** A walk starts only at a graph record (`MOV_WALK_ROOT_NOT_RECORD`).
- **The settings form is retired.** `listen to x { … }` is an error under every pin (`MOV_LISTEN_SETTINGS_RETIRED`); `listen-fire upgrade` rewrites it where the module declares `listenSettingsBecome`. A diagnostic may carry `walks`: a host that narrows its catalog by a file's hops narrows by them before upgrading again ([language-versions.md](language-versions.md)).
- **Catalog snapshot version 3.** It drops the settings listen's members, and with version 2 before it, `awaitable`, `watchable` and `resolvesEmpty`; an edge a listen or wait lands on states its `identity`. Versions 1 and 2 are refused by name ([catalog-snapshot.md](catalog-snapshot.md#versions)).
- **New refusals, for checker parity.** `MOV_HOP_ALIAS_REPEATED` (one alias on two hops), `MOV_HOP_READS_EARLIER_HOP` (a run's walk reading an earlier hop's alias), `MOV_LISTEN_UNION_HOP` (a listen hop through or onto a union), `MOV_ABSENT_REQUIRED` on a wait off a record that may be missing, `MOV_LISTEN_UNWATCHABLE` on a listen filter reading an uncarried hop or `WITHIN` on a listed hop, and `MOV_EVENT_UNDESCRIBED` on a listen on an undescribed connection. A listen judged on arrival no longer gets the fetch cost diagnostics. The missing-listen hint for a record-type parameter shows the shortest walk to a listenable edge landing on it.
- **Upgrade warnings.** `MOV_FIELD_MEANING_CHANGED` warns where a program reads a field its module's `changedIn` names, on a check for the upgrade from before that release; it does not hold the pin. An owned literal is validated by its scalar's `format`, never its name.
- **Engine 0.13.** It carries main's fix to the `writtenType` stamp.
- **Story analysis version 2.** An awaited traversal says `listenable`; a listen node carries `path` and loses `events`, `narrowing` and `eventTypes` ([story-analysis.md](story-analysis.md#versions)).

## After 0.13.0

- **A listen over a union is one plan per member.** A plan hop may carry `memberOf`, the union its edge lands on, when the plan watches one member of it (`to`). The platform's checker plans such a listen once per member, as `listen-fire` does, and its hosts read `memberOf`: listing that hop keeps only records of the member's type ([listen_plan.ts](../../packages/engine-contracts/listen_plan.ts)). `MOV_LISTEN_UNION_HOP` is no longer raised.
