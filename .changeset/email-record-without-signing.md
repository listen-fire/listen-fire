---
"@listen-fire/email": patch
---

An email's record carries only the email's own fields: Mailgun's `token`, `timestamp` and `signature` verify a post and are dropped, where they were merged into every record (and so reached every run, every write made from it, and the delivery's kept arrivals). The module names them in `inbound.redactFields`, so a kept request drops them from its body too.
