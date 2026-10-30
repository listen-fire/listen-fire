---
"@listen-fire/handbook": patch
---

`testing`'s captured adapter schemas say `listenable` on Slack's `Replies` and the ask `Response` edges, in place of the retired `awaitable` and `watchable`; Slack's `Replies` also carries `identity: "Timestamp"`.
