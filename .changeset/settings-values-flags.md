---
"@listen-fire/movement-lang": minor
"@listen-fire/engine-contracts": minor
---

`listenSettingsBecome` may spell a settings value as `true` or `false` (`values: { app_mention: true }`): Slack's `events: ["app_mention"]` becomes ``m.`Mentions App` == true``. A listenable edge's `carries` may skip a hop it does not carry (a reaction carries its channel, not its message); describe refuses a carried hop on no path to the edge.
