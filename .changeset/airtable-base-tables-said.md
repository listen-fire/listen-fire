---
"@listen-fire/airtable": patch
---

A base's description says in its first sentence that each of its tables is an edge named after the table, which rows are read and written along: off a connection made at the base (`connect … { base: "CRM" }`, then `c-[:Companies]->`) or off the base narrowed by name (`b-[:Companies]->`). The first sentence is what `listen-fire catalog` prints for a record type; the description used to say this in its second sentence, with the retired `base:` construction spelling.
