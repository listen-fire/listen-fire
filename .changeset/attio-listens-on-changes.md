---
"@listen-fire/attio": minor
"@listen-fire/fake-channels": patch
---

Attio is listened to on a record's `Changes` (`listen to crm-[:Deals]->-[c:Changes WHERE c.Field == "Stage"]-> fire f`, `function f(c: <crm-[:DealChange]->>)`), each object's changes their own record type (`DealChange`, `CompanyChange`, …) with `Kind` (`created`, `updated`, `deleted`) and, on an update, `Field`, the changed attribute's title. A webhook delivery is the arrivals on each changed record's `Changes`, carrying the record as Attio holds it now, `about` it and `occurredAt` when the value took effect; a redelivery of the same change runs nothing. One webhook per connection serves every listen on `Changes` (`ensureEventSubscription({ edge: "Changes" })`). A run can wait on a record's next change: `awaitKeys` keys it by the record id. Adapter protocol 2.6. The `Webhook Event` type, `listEventTypes`, `subscribableEvents` and the snapshot trigger are gone. The fake Attio stamps each value it stores with `active_from` and each record with `created_at`, as Attio does.
