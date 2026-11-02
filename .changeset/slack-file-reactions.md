---
"@listen-fire/slack": patch
"@listen-fire/fake-channels": patch
---

A reaction on a file arrives again: on the `Reactions` of each message that shares the file (read from `files.info`), as a reaction on that message does, its `Channel` and `Message` that message's. Since 0.13 it was dropped. When Slack does not answer `files.info` the delivery fails by name and Slack sends it again; a file in no conversation is on no message, and runs nothing. The fake Slack's `files.info` answers a seeded file's `shares`.
