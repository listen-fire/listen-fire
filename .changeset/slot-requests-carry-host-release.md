---
"@listen-fire/engine-contracts": patch
---

Adapter protocol 2.8: a slot request may carry `hostRelease`, the release of the runner that sent it (`SlotRequestEnvelope`); one without it comes from a runner before 0.15.2. `PROTOCOL_MINOR` is 8.
