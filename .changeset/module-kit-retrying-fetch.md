---
'@listen-fire/module-kit': patch
---

`retryingFetch` wraps `ctx.fetch` with exponential backoff and jitter on 429, 5xx and network errors, honouring `Retry-After`, with capped attempts and total wait. The limits door now reports a 503 that carries a `Retry-After` as a throttle, as it does a 429, and a module may declare `hostLimits: true` without declaring `limits`.
