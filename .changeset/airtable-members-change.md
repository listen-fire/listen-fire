---
"@listen-fire/airtable": patch
---

`Bases` and a base's `Tables` declare how a listen learns their members changed in one member: `Bases` `membersChange: { relistEverySeconds: 3600 }`, `Tables` `membersChange: "pushed"` (where they declared `cheapToList` with `relistEverySeconds` or `parentChanges`).
