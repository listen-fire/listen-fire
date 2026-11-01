---
"@listen-fire/airtable": minor
"@listen-fire/fake-channels": patch
"@listen-fire/handbook": patch
---

Airtable is listened to on a table's `Changes`, walked to by name (`listen to at-[b:Bases WHERE b.Name == "Finance"]->-[t:Tables WHERE t.Name == "Expenses"]->-[c:Changes WHERE c.Kind == "created"]-> fire review`). A change lands on `Change` (`Kind`; on an update `Field`, `Old` and `New`, one change per field), and its `Record` is the row as the change left it. One webhook per table a listen lands on, and one schema webhook (`tableMetadata`) per base whose tables a listen narrows: `Tables` declares `parentChanges: pushed`, so a table renamed into the WHERE is watched from the rename. `Bases` is cheap to list and listed again hourly. A run can wait on a table's next change (`awaitKeys`). Adapter protocol 2.6. The root's `Base` collection is now `Bases`; `Record Change`, `listenConfig`, `subscribableEvents`, `subscriptionScopeKeys` and `listEventTypes` are gone, and a 0.12 settings listen is rewritten by `listen-fire upgrade`. The module has a handbook section. The fake Airtable models schema webhooks and renames a table (`POST /airtable/control/rename-table`).
