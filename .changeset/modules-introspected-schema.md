---
"@listen-fire/module-kit": patch
---

An adapter module's manifest may say `introspectedSchema: true` on the wire: its schema comes from the connected account, so describing it needs a credential. module-kit states it from the module's manifest (Airtable, Attio, Affinity and Google Sheets already declared it). `listen-fire modules show` reads it to say a module's records cannot be listed without an account.
