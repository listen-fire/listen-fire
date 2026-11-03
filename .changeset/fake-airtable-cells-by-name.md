---
'@listen-fire/fake-channels': patch
---

The fake Airtable keeps a written cell under its field's name, whichever of the field's id or name the write used, and reads it back by name, as Airtable does. It kept the key the write sent, so a row `@lf/airtable` had created (it writes by field id) read back with its fields missing: a `?:` on that row saw an empty field and overwrote it, and an update by id left the seeded name's value beside it.
