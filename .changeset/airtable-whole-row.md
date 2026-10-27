---
"@listen-fire/airtable": patch
"@listen-fire/fake-channels": patch
---

An Airtable webhook asks for every field's current value (`includeCellValuesInFieldIds: "all"`) beside the previous ones, so a change event's `Record` is the whole row, not just the cells that changed; `Changed Fields` still names only those. `ensureEventSubscription` registers anew a held webhook whose specification asks for less (it lists the base's webhooks to read it). A table describes its rows' Airtable id as a read-only `Id` field, unless it has a field of that name. The fake Airtable lists a base's webhooks with their specifications and sends a change's other cells as `unchanged` when the webhook asked for them. Both additive to the field-change listen, new in this unreleased cycle.
