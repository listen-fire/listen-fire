---
"@listen-fire/engine-contracts": patch
"@listen-fire/engine": patch
---

Adapter protocol 2.8: a slot request may carry `hostRelease`, the release of the runner that sent it (`SlotRequestEnvelope`); one without it did not state its sender's release (a runner before 0.15.2, or a host or module that does not set it). `PROTOCOL_MINOR` is 8. `SlotClient` (`@listen-fire/engine/public/module-wire`) takes an optional `hostRelease` and sends it when set.
