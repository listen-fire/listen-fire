---
"@listen-fire/module-kit": minor
"@listen-fire/slack": patch
---

A module's inbound declaration may name `redactFields`: the body and query fields that may carry a credential, dropped before a request is kept (a JSON body's own members, a form's fields and the members of a JSON object a form field holds, and the query's parameters). A body that names none is kept byte for byte. `@lf/slack` names its legacy verification `token`. A header whose name holds `token`, `key`, `auth`, `hmac` or `password` is never kept.
