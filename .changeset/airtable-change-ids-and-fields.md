---
"@listen-fire/airtable": patch
---

A table's change names what 0.12's `Record Change` did again: `Changed Fields`, the fields the edit touched (every field a created row was given, none for a deleted one), and `Base Id`, `Table Id` and `Record Id`, Airtable's ids for the row's base, table and row (a deleted row's too, which `Record`, a read, cannot reach). Since 0.13 they were not on the change.
