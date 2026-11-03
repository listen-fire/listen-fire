---
'@listen-fire/airtable': minor
---

Needs the listen-fire 0.15 engine: release this only with listen-fire 0.15.0. A field Airtable can leave empty is typed as maybe absent (`mayBeAbsent` on its descriptor): text of every kind, a number, a date, a single select, a collaborator, a barcode, a formula, a rollup, AI text, the last-modified time and author. A checkbox Airtable leaves out of a row is read as `false`, and a list field (multiple selects, collaborators, attachments, lookups, linked rows) as `[]`, wherever a row is read: a table's rows, linked rows, a change's `Record`, `Current` and `Previous`. An autonumber, a count, the created time and the creator stay always present. The handbook section says so. Under a 0.14 engine this would refuse programs that checked before, which is why it ships with the 0.15 compatibility key.
