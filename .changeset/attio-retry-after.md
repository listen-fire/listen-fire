---
'@listen-fire/attio': patch
---

A 429 from Attio is retried after the `Retry-After` it asked for (seconds or an HTTP date), or after an exponential backoff when it sent none, instead of a fixed extra 30 seconds. Attio now sends through module-kit's `retryingFetch`, as `@lf/mcp` does.
