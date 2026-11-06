---
"@listen-fire/slack": patch
"@listen-fire/attio": patch
---

`getActorCandidates` throws when it could not look the member up (no Slack client, a failed `users.info`, a failed Attio member fetch), so the host names who acted unknown instead of answering that nobody did. A member with no email is still no candidate. Slack asks `users.info` through its bounded delivery client, so a rate limited call fails at once.
