---
"@listen-fire/engine": patch
"@listen-fire/movement-lang": patch
"@listen-fire/engine-contracts": patch
"@listen-fire/embed": patch
"@listen-fire/email": patch
---

A listen's WHERE reads an arrival's fields by the names the program writes, as its run does, also where a module keys its records by its own field ids. The catalog's position carries `fieldIds` (name → id, where the two differ), and each host reads every record an arrival carries by those names before judging it (`named_fields` in Rust, `namedFields`/`namedArrival` in TypeScript, held by both to `conformance/listen-field-names.json`). So `inbox-[e:Emails WHERE e.Subject CONTAINS "Series A"]->` fires: before, an email listen reading any field but `Key` never fired, and nothing said so. An email's arrival also carries its derived `Body`.
