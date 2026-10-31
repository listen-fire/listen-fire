---
"@listen-fire/webhook": minor
---

Each delivery arrives on the connection's `Requests` edge, its body untyped JSON, and the listen states the node it is: `listen to stripe-[:Requests]-><Payment> fire f`. The module declares how a 0.12 `listen to stripe { payload: <Payment> }` becomes it (`listenSettingsBecome`), and no longer declares `listenConfig`, a `fires` edge or event types. A delivery the sender names by an id (Stripe's `id`, the credential's `idField`) is that arrival's identity; one it names by nothing is its own. Adapter protocol 2.6.
