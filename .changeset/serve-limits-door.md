---
"@listen-fire/engine": patch
---

`lf serve` and `lf serve --doors-only` start with a module that declares `hostLimits` imported, `@lf/mcp` among them. Such a module asks lf's limits door, on serve's own port, before each request to its provider, including while lf describes its connection at startup; serve now answers that door before it opens its session, where it used to wait on the module while the module waited on a door serve did not yet answer, and never became ready.
