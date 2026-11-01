---
"@listen-fire/slack": patch
---

A message's `Timestamp` and a press's `At` each have a field id of their own (`timestamp`, `pressed_at`), and an arrival carries the instant under it. A host reads an arrival's fields by id before judging a listen, and the ids were Slack's raw `ts` and `action_ts`, so `m.Timestamp WITHIN 3d` compared Slack's raw epoch text and a lunch poll's presses never fired `count_vote`.
