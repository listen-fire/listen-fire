---
"@listen-fire/airtable": patch
"@listen-fire/engine": patch
---

An Airtable listen can fire on one field changing, and on it changing to a value: `listen to hiring { base: "app…", table: "tbl…", field: "Stage", becomes: "Interview" } fire …` runs only when a change touched `Stage` and made it `Interview` (it was not `Interview` before). The `Record Change` event names the fields a change touched (`Changed Fields`) and reaches the row as it was through an `Old Record` edge, typed like the table, so `change-[:`Old Record`]->.Stage` is the `Stage` enum. A new Airtable webhook asks for previous cell values; select cells in a delivery read as their choice's name. The engine's listen scope gate (`eventMatchesTriggerScope`) applies `field` over an event's `changedFields` and `becomes` over its payload's `fields` and `previous`.

The checker holds both keys against the table the listen watches. A module declares them with two new listen config formats: `field` (one field of the watched record) and `field-value` (a value of the field the `field` key names, beside exactly one `field` key). A `field` the table lacks is refused, naming the table's fields (`MOV_LISTEN_BAD_CONFIG`); a `becomes` that is not a choice of a select field is refused with a did-you-mean (`MOV_ENUM_UNKNOWN_VALUE`), and one of the wrong type for any other field (text for a number field) is refused (`MOV_LISTEN_BAD_CONFIG`), as is a `becomes` without a `field`. Only configs that could never fire are refused. `lf` applies the same `field` and `becomes` gate as the engine.
