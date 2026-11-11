# @listen-fire/attio

## 0.13.2

### Patch Changes

- 32db044: `getActorCandidates` throws when it could not look the member up (no Slack client, a failed `users.info`, a failed Attio member fetch), so the host names who acted unknown instead of answering that nobody did. A member with no email is still no candidate. Slack asks `users.info` through its bounded delivery client, so a rate limited call fails at once.
- 74127fc: The actor each module names now says `proven: true`: the host admits a delivery only when the source system signed it (Slack, Telegram, Attio, WhatsApp), or the address is the source system's own answer to the connection's credential (Granola). Email states nothing, since nothing vouches for a `From` line.

## 0.13.1

### Patch Changes

- eb1f52f: A run a listen fires reads who caused it as its actor again (`@actor_email`, `@actor_name`, `@actor_id`, and the acting user resolved from it): each module reads it from the record that arrived, where 0.13.0 read the 0.12 event's payload, which a 0.13 run is never handed, and answered no actor.
  
  - Email: the sender, and each forwarding inbox the mail came through as a relay.
  - Slack: who posted the message, added the reaction or pressed the button.
  - Telegram and WhatsApp: the sender.
  - Attio: the workspace member who made the change. A change now keeps Attio's `actor` (`{ type, id }`) beside its named fields for this; it was dropped at delivery.
- 4516899: Each module says who acted where it builds an arrival (adapter protocol 2.7 `actor`): who posted, reacted or pressed in Slack, a Granola meeting's owner, a mail's sender, a Telegram or WhatsApp sender, the Attio member who made a change. A run reads `@actor_*` from it; `extractActor` and `getActorCandidates` read it from the run's trigger (`event.arrival.actor`), Slack still resolving the member's email through `users.info` and email still adding its forwarding relays. `module-kit` gains `firedActor(event)`.
- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.13.0

### Minor Changes

- 3bb7aa9: Attio is listened to on a record's `Changes` (`listen to crm-[:Deals]->-[c:Changes WHERE c.Field == "Stage"]-> fire f`, `function f(c: <crm-[:DealChange]->>)`), each object's changes their own record type (`DealChange`, `CompanyChange`, …) with `Kind` (`created`, `updated`, `deleted`) and, on an update, `Field`, the changed attribute's title. A webhook delivery is the arrivals on each changed record's `Changes`, carrying the record as Attio holds it now, `about` it and `occurredAt` when the value took effect; a redelivery of the same change runs nothing. One webhook per connection serves every listen on `Changes` (`ensureEventSubscription({ edge: "Changes" })`). A run can wait on a record's next change: `awaitKeys` keys it by the record id. Adapter protocol 2.6. The `Webhook Event` type, `listEventTypes`, `subscribableEvents` and the snapshot trigger are gone. The fake Attio stamps each value it stores with `active_from` and each record with `created_at`, as Attio does.

### Patch Changes

- c67d9a6: A root a listen can start at counts as backed by being `listenable`, where it read the retired `fires`, which the catalog no longer carries.
- Updated dependencies [4c09d6a]
- Updated dependencies [faa7050]
- Updated dependencies [acec0bd]
- Updated dependencies [301dab3]
- Updated dependencies [3c2774e]
- Updated dependencies [dd81bed]
- Updated dependencies [c4af6cc]
- Updated dependencies [a942076]
- Updated dependencies [46efd84]
- Updated dependencies [9520af9]
- Updated dependencies [9e9316c]
- Updated dependencies [5bfc3f2]
- Updated dependencies [66d32d5]
- Updated dependencies [16e3776]
- Updated dependencies [16e3776]
- Updated dependencies [da1a05b]
- Updated dependencies [abc777e]
- Updated dependencies [ad23b9c]
  - @listen-fire/module-kit@0.13.0

## 0.12.7

### Patch Changes

- 89f92c1: A 429 from Attio is retried after the `Retry-After` it asked for (seconds or an HTTP date), or after an exponential backoff when it sent none, instead of a fixed extra 30 seconds. Attio now sends through module-kit's `retryingFetch`, as `@lf/mcp` does.

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
