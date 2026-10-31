---
"@listen-fire/slack": patch
---

`Replies` and `Interactions` no longer declare `resolvesEmpty`, which 0.13 retires: a deleted message leaves the wait waiting on every edge, so there is nothing to declare, and a 0.13 `listen-fire` refuses a module that still declares it.
