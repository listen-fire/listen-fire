---
"@listen-fire/attio": patch
"@listen-fire/email": patch
"@listen-fire/granola": patch
"@listen-fire/slack": patch
"@listen-fire/telegram": patch
"@listen-fire/whatsapp": patch
"@listen-fire/module-kit": patch
---

Each module says who acted where it builds an arrival (adapter protocol 2.7 `actor`): who posted, reacted or pressed in Slack, a Granola meeting's owner, a mail's sender, a Telegram or WhatsApp sender, the Attio member who made a change. A run reads `@actor_*` from it; `extractActor` and `getActorCandidates` read it from the run's trigger (`event.arrival.actor`), Slack still resolving the member's email through `users.info` and email still adding its forwarding relays. `module-kit` gains `firedActor(event)`.
