---
"@listen-fire/slack": minor
---

`Replies` declares `listenable: true` and `identity: 'Timestamp'` in place of the retired `awaitable` and `watchable`, as the 0.13 line requires. `await m-[:Replies]->` waits for a new reply as before.
