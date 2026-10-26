---
"@listen-fire/engine": patch
---

`lf connect` sets up an OAuth app only when it is needed: a module whose users may also sign in otherwise (a token: `@lf/attio`'s `attio_token`, `@lf/mcp`'s `mcp_token`) is asked whether to (no by default), and `--yes` sets none up unless `--oauth-authorize-url`/`--oauth-token-url` are given. Adding that module's OAuth credential without an app is refused, naming how to set one up.
