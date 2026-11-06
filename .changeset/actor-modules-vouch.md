---
"@listen-fire/slack": patch
"@listen-fire/telegram": patch
"@listen-fire/attio": patch
"@listen-fire/whatsapp": patch
"@listen-fire/granola": patch
---

The actor each module names now says `proven: true`: the host admits a delivery only when the source system signed it (Slack, Telegram, Attio, WhatsApp), or the address is the source system's own answer to the connection's credential (Granola). Email states nothing, since nothing vouches for a `From` line.
