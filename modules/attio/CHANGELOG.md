# @listen-fire/attio

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
