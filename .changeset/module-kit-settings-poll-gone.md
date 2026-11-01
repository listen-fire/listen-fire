---
"@listen-fire/module-kit": minor
"@listen-fire/dealroom": patch
"@listen-fire/evertrace": patch
"@listen-fire/github": patch
"@listen-fire/gmail": patch
"@listen-fire/granola": patch
"@listen-fire/system": patch
---

A module's `poll` takes an edge's input alone (`PollEdgeInput`) and answers its arrivals (`PollEdgeAnswer`); `PollInput` and `PollAnswer` are gone from the kit, and a 0.12 settings poll's input reaches no module. Dealroom, Evertrace, GitHub, Gmail, Granola and System no longer refuse that input themselves. The in-process `Adapter.ensureEventSubscription` takes an edge's subscription; removing and refreshing one still take a 0.12 settings listen's webhook, so a host can remove it.
