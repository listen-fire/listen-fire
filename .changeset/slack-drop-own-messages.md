---
"@listen-fire/slack": patch
"@listen-fire/module-kit": patch
---

Slack declares a setting, `drop_own_messages`, off unless it is `on`: a message or reaction the app itself made, by its bot user or its bot id, is then no arrival. An app Slack cannot identify drops nothing and says so. `module-kit` lets an adapter module declare `settings` in its manifest.
