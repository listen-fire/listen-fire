---
'@listen-fire/module-kit': patch
'@listen-fire/mcp': patch
---

`retryingFetch` no longer retries a request the host refused by policy: an error carrying the code `LF_POLICY_REFUSAL` (`POLICY_REFUSAL_CODE`, `isPolicyRefusal`) is thrown at once with its own message, not retried as a network error. `@lf/mcp` benefits through its wrapped fetch.
