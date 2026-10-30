---
"@listen-fire/engine": patch
---

The `slack_v0` signature scheme refuses a request whose `x-slack-request-timestamp` is more than five minutes from now, as Slack advises, so a captured delivery cannot be replayed later. A door that verifies Slack through the engine's inbound core refuses it 401.
