---
"@listen-fire/granola": minor
---

Granola meeting notes arrive on the connection's `Meetings` edge, readable and listenable, polled every five minutes (lf.yaml `pollEvery` overrides it for a connection): `listen to granola-[n:Meetings WHERE n.Folders CONTAINS "deals"]-> fire f`. Each note new or changed since the last poll arrives once, versioned by its `Updated At`, with `occurredAt`. A new field, `Folders`, lists the folders a note is in by name, lowercased, and takes `CONTAINS`; the module applies the taken filter itself. It declares how a 0.12 `listen to granola { folder: "Deals" }` becomes it (`listenSettingsBecome`, the folder lowercased as 0.12 compared it) and no longer declares `listenConfig`, a `fires` edge or event types. Adapter protocol 2.6.
