---
"@listen-fire/airtable": patch
"@listen-fire/embed": patch
---

An Airtable change carries its base and table (`parents`, each a `Base` or `Table` with `Id` and `Name`), read from Airtable's meta API once per base, and a table's `Changes` declares them (`carries`: its base and table walked to from the workspace, its table alone on a connection positioned at a base). A host that lists no members judges a listen narrowed by base or table from the change alone. The embedded host accepts such a listen: it refuses only an earlier hop whose record the listen's last edge does not carry. Its peer floors on `@listen-fire/engine` and `@listen-fire/movement-lang` rise to `>=0.14.2`, the core whose judge reads that record: an older judge skips the hop and would fire under every table.
