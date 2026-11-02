---
"@listen-fire/attio": patch
"@listen-fire/email": patch
"@listen-fire/slack": patch
"@listen-fire/telegram": patch
"@listen-fire/whatsapp": patch
---

A run a listen fires reads who caused it as its actor again (`@actor_email`, `@actor_name`, `@actor_id`, and the acting user resolved from it): each module reads it from the record that arrived, where 0.13.0 read the 0.12 event's payload, which a 0.13 run is never handed, and answered no actor.

- Email: the sender, and each forwarding inbox the mail came through as a relay.
- Slack: who posted the message, added the reaction or pressed the button.
- Telegram and WhatsApp: the sender.
- Attio: the workspace member who made the change. A change now keeps Attio's `actor` (`{ type, id }`) beside its named fields for this; it was dropped at delivery.
