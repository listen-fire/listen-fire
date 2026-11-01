---
"@listen-fire/engine": minor
---

A kept delivery carries the request it was received as: `NewDelivery.request` and `DeliveryRow.request` (`{ method, path, query, headers, body, checkpoint? }`, the body base64, the headers its module reads), sent to `inbound.keepDelivery` and answered by `inbound.delivery` while the delivery is kept. It is sensitive. The run host's delivery contract checks a store keeps it, never lists it, and forgets it past retention (docs/contracts/store-slot.md).
