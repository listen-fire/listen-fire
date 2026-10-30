---
"@listen-fire/handbook": patch
"@listen-fire/slack": patch
"@listen-fire/telegram": patch
"@listen-fire/whatsapp": patch
---

Examples wait with `await x-[:E]->` in place of the retired `await first(x-[:E]->)`, which a 0.13 check respells. The handbook drops its common-mistakes entry against writing `await` before a bare walk, which is now the form.
