---
"@listen-fire/engine": patch
---

`lf credential add` for a plugin module (`--module @lf/jev`) prints how a movement calls its plugins (``import { `@lf/jev` as jev } from plugins``) instead of an adapter's `connect … using …`, which does not apply to a plugin.
