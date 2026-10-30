---
"@listen-fire/slack": minor
---

A message write takes `Buttons` (`[{ Text, Value }]`), posted as the message text and one button per entry, and a run waits for a press with `await msg-[:Interactions]->`. A press is an `Interaction { Id, At }` with its `Actions` (`Action { Value, Text }`) and the member who pressed (`By`); the `Value` is typed by the Values the buttons were written with. `Replies` takes the first reply already in the thread or the next to arrive, and a deleted message ends either wait. The module speaks adapter protocol 2.5 (`awaitKeys`, and presses, thread replies and deletions reported as arrivals with the delivery) in place of `resolveAwait` and `wakeKeys`, and so needs a listen-fire that reads form-encoded deliveries: Slack posts a press as `payload=<json>`. The handbook section teaches buttons and waits; callback ids in Block Kit are no longer taught.
