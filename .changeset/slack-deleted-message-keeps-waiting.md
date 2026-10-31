---
"@listen-fire/slack": patch
---

The Slack handbook section says a message deleted while a run waits on it leaves the wait waiting (listen-fire 0.13): nothing after the `await` runs, so race the wait with a `sleep`. It said the deletion ended the wait.
