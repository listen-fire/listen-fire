---
"@listen-fire/webhook": patch
"@listen-fire/engine": patch
---

A delivery's acknowledgement counts what it brought again: `eventsProcessed` is the arrivals (and any events) the delivery reported, where since 0.13 it was always 0, as modules report arrivals. `@lf/webhook` declares `inbound.redactFields`, so a kept delivery's request drops the query parameters and top-level body fields a sender that cannot sign puts a credential in: `token`, `access_token`, `api_key`, `apikey`, `api_token`, `secret`, `client_secret`, `password`, `signature`. The run still reads the body as it was sent.
