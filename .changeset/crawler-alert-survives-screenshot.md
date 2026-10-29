---
"@listen-fire/web": patch
---

A gated document source whose crawl fails now raises its alert even when the host cannot keep the screenshot of the failed page. The screenshot step alone is guarded: a screenshot that cannot be taken or kept is logged and the alert names none, where before the storage failure swallowed the alert.
