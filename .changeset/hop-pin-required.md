---
"@listen-fire/engine": patch
---

A describe may mark a field `pinned: true`: a read of that type must pin the field in its `WHERE` with `==` (to a literal or a name in scope, among the `WHERE`'s `AND`-joined conditions, in a `WHERE` that calls no function and tests no `EXISTS`), because the source takes it as an argument of the read. `lf check` refuses a read that does not (`MOV_HOP_PIN_REQUIRED`), naming the fields and the form to write. Both catalog builders carry it as the position's `pinnedProperties`. Writes are unaffected, and no module set the flag before `@lf/mcp` did, so every program that checked before checks the same unless it reads an MCP tool without its required arguments, which failed at run.
