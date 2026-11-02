---
"@listen-fire/airtable": patch
"@listen-fire/embed": patch
---

An Airtable change carries its base and table (`parents`, each a `Base` or `Table` with `Id` and `Name`), read from Airtable's meta API once per base, and a table's `Changes`, walked to from the workspace, declares them (`carries`). A host that lists no members judges a listen narrowed by base or table from the change alone. The embedded host accepts such a listen: it refuses only an earlier hop whose record the listen's last edge does not carry. It needs the judge of the core release that carries this change; an older one would fire under every table.
