# @listen-fire/engine-contracts

## 0.15.3

### Patch Changes

- 27fcf14: Adapter protocol 2.9: an actor identity may carry `proven`, true when the module checked that the source system vouches for it. `normalisedActor` and `ACTOR_FIELDS` turn an identity into the `Actor` fields a host offers (`docs/contracts/actor-field.md`). `PROTOCOL_MINOR` is 9.
- 6882160: `normalisedActor` trims one named set of characters, the same one `lf` trims, so an address with a byte order mark or a next line character reads the same in both. JavaScript's `trim` alone stripped U+FEFF, and Rust's alone stripped U+0085.

## 0.15.2

### Patch Changes

- 430fec9: The engine's artifact carries the deep-recursion fix. A run that goes deeper than the WASM engine's stack holds ends with `CallDepthExceeded` (`MOVENG_CALL_DEPTH`, `stackRanOut: true`, its message saying the engine's stack ran out) where it crashed before, on the engine's own check or, when V8's stack runs out first, by the host. `movement-lang` exports `EngineStackRanOut`, what an engine segment throws for the second. The shadow stack goes from 2 MiB to 3 MiB, so whatever fitted before still does.
  
  A value nested past 3,000 levels is refused as it crosses to the host, by name. This ships in a patch and not under a new compatibility key: the rule about a tightened engine rule does not apply, since the cap refuses only what crashed before.
- 45a5957: Adapter protocol 2.8: a slot request may carry `hostRelease`, the release of the runner that sent it (`SlotRequestEnvelope`); one without it did not state its sender's release (a runner before 0.15.2, or a host or module that does not set it). `PROTOCOL_MINOR` is 8. `SlotClient` (`@listen-fire/engine/public/module-wire`) takes an optional `hostRelease` and sends it when set.

## 0.15.1

No changes in this release.

## 0.15.0

### Minor Changes

- 2efc8c2: 0.15.0, a new compatibility key: a word an expression reads as itself is never a name, `coalesce` is typed as `a ?? b`, a `List.groupBy` or `List.keyBy` key that may be absent is refused, `first`, `[0]`, `Text.join` and `reduce` over the records an unordered walk's block answers, or over a list literal spreading them, are refused, a built-in inside walk brackets is spelled as outside them (`LENGTH` of a list there as `count(xs)`), and a built-in that can answer nothing (given a value that may be absent, text it may read no date from, or a pattern or money figure that may not match) types its answer `T | absent`. The engine package's schema projection types a field a record may not hold (`mayBeAbsent`) as `T | null` where it is read and `T` where it is written. A pin of `0.14.x` is refused by name ("validate it under 0.15.0 and upgrade it"). The wasm artifacts are rebuilt.

### Patch Changes

- Updated dependencies [fa0d26d]
- Updated dependencies [2efc8c2]
  - @listen-fire/movement-lang@0.15.0

## 0.14.2

### Patch Changes

- The listen judge reads a listed hop's record from the arrival when the plan says the edge carries it, finding a carried parent by its record type.

## 0.14.1

### Patch Changes

- 0817092: `RemoteAdapter.preprocessInbound` is typed as what the wire answers, `{ events, arrivals?, checkpoint? }`, not only the 0.12 events. `engine-contracts` exports the answer as `PreprocessedInbound`, and `Adapter.preprocessInbound` returns it.

## 0.14.0

### Minor Changes

- 0.14.0, a new compatibility key: a field is never read through a value that may be missing (`?.`), a walk off a union lands on one of its members (`is` narrows it), `lazy` and the loop guard slot are retired. See docs/language/migrating-to-0.14.md.

### Patch Changes

- 0a9e7fd: The `Adapter` type matches adapter protocol 2.6's subscriptions for an edge's arrivals. `removeEventSubscription` and `refreshEventSubscription` take either an edge's input (`edge`, `filter?`, `scope?` a record id, as `ensureEventSubscription` does) or the 0.12 webhook's (`scope` a `{ base, table }` record), so a module class that requires `edge` is assignable to `Adapter`. New types: `EdgeSubscription`, `EnsureEdgeSubscriptionInput`, `RemoveEdgeSubscriptionInput`, `RefreshEdgeSubscriptionInput` (module-kit re-exports them).
- Updated dependencies
  - @listen-fire/movement-lang@0.14.0

## 0.13.1

### Patch Changes

- 3bbff43: A field that declares `changedIn` may also declare `unchangedValues`, the values that mean what they always did. A check for an upgrade does not warn (`MOV_FIELD_MEANING_CHANGED`) where a program compares the field only with literals among them (`==`, `!=`, `CONTAINS`, `IN`); the checker compares the literal with the list and reads nothing into its spelling. Gmail declares its own labels (`INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`, `SENT`, `DRAFT`, `SPAM`, `TRASH`, `CHAT`, the five `CATEGORY_` tabs) for `Labels`, so a 0.12 listen on `INBOX` upgrades and moves the pin without `--all`, while one on a custom label's id still holds it.

## 0.12.13

### Patch Changes

- The command is now `listen-fire`, no longer `lf`: every message, hint, description and handbook page that tells someone what to run names `listen-fire` (for example `listen-fire connect s3_files`, `listen-fire credential add --module webhook <name>`). Module names (`@lf/…`), `lf.yaml`, `.lf/` and `LF_*` variables are unchanged.

## 0.12.12

No changes in this release.

## 0.12.11

No changes in this release.

## 0.12.10

### Patch Changes

- 1cddbb8: A module's `checkInbound` answer can carry `deliveryId` in TypeScript: `InboundCheck`'s `accepted` outcome has it, and module-kit's `accepted(events, { deliveryId })` sets it. The wire and `lf` already took it (a repeat under the same id is answered `duplicate: true` and runs nothing). Additive.

## 0.12.9

No changes in this release.

## 0.12.8

No changes in this release.

## 0.12.7

No changes in this release.

## 0.12.6

### Patch Changes

- Adapter protocol 2.N: a module states the protocol minor it uses (`protocolMinor` on its manifest), and lf and the engine speak 2.0–2.2 and refuse a module outside that range by name. lf checks a slot module's protocol at start, so a slot module must answer `manifest` before anything else.
