---
"@listen-fire/engine": patch
---

A field read off a name bound to a walk reads each record the walk landed on, as the walk read in place does: after `row = change-[:Record]->`, `"${row.Stage}"` is the Stage, where it read as empty (`change-[:Record]->.Stage` already read it). This holds for any walk bound to a name, not only one from the event: a field read off a list of records reads each record's field. A read off a list holding anything else is unchanged.
