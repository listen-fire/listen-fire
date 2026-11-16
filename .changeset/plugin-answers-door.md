---
'@listen-fire/module-kit': minor
---

A module's context gains `ctx.host.invalidatePluginAnswers({ plugin, args? })`: it tells its host that a pure plugin's kept answers changed (adapter protocol 2.10, `plugins.invalidate`), the one for `args` or every answer of `plugin`. Served as a process it posts to the host's plugins door (`LF_HOST_URL`); a host before 2.10, or none, keeps no answers and has none to forget (`keepingNoAnswers`). A test that builds a `ModuleContext` by hand adds `host`.
