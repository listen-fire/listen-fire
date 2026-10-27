---
"@listen-fire/airtable": patch
"@listen-fire/engine": patch
---

An Airtable listen can fire on one field changing, and on it changing to a value: `listen to hiring { base: "app…", table: "tbl…", field: "Stage", becomes: "Interview" } fire …` runs only when a change touched `Stage` and made it `Interview` (it was not `Interview` before). The `Record Change` event names the fields a change touched (`Changed Fields`) and reaches the row as it was through an `Old Record` edge, typed like the table, so `change-[:`Old Record`]->.Stage` is the `Stage` enum. A new Airtable webhook asks for previous cell values; select cells in a delivery read as their choice's name. The engine's listen scope gate (`eventMatchesTriggerScope`) applies `field` over an event's `changedFields` and `becomes` over its payload's `fields` and `previous`.
