---
"@listen-fire/slack": minor
---

Slack names the fields it could not read on an arrival (`unknown`, adapter protocol 2.6), so a listen whose filter reads one is reported undecided rather than skipped: a message's `Mentions App` when it cannot read the app's bot user (`auth.test`), and a carried channel's `Name` when it cannot read the channel (`conversations.info`), instead of guessing or dropping the channel.
