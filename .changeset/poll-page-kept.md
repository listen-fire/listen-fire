---
"@listen-fire/engine": minor
---

A poll's delivery keeps the page the poll read as its `request` (`{ adapter, install?, credential?, arrivals }`) in place of a request, so `listen-fire listens replay` can judge those arrivals again through one listen that shared the poll, asking the module nothing. Like a request it is sensitive, forgotten past `deliveries.retainDays`, and printed only by `deliveries show --request` (docs/contracts/store-slot.md).
