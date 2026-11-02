---
"@listen-fire/airtable": patch
---

A `unique by` write along a base's table edge (`write base-[:Companies]-> { unique by (Name) … }`, the base reached by `-[b:Bases WHERE b.Name == "…"]->`) updates the row it finds instead of failing with "cannot attach an existing Companies to Base". A row is in its base by being in one of the base's tables, so the update reports it attached already; a write off another base still fails by name.
