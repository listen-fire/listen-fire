---
'@listen-fire/mcp': patch
---

An MCP connection retries a request to its server that failed with a 429, a 5xx or a network error, with exponential backoff and jitter, honouring `Retry-After` and holding the connection on every instance. A call to a tool that changes things is sent again only when the server asked for the wait or was never reached; read-only tools, `initialize` and `tools/list` are retried freely. Four attempts and 20 seconds at most.
