---
"@listen-fire/slack": minor
---

`Replies` declares `listenable: true` and `identity: 'Timestamp'` in place of the retired `awaitable` and `watchable`, as the 0.13 line requires. `await m-[:Replies]->` waits for a new reply as before. The core peers now start at 0.13.0: a 0.12 host does not know `listenable`, and would drop it, leaving `Replies` an edge nothing can wait on.
