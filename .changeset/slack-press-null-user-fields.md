---
"@listen-fire/slack": patch
---

A button press whose member fields (`username`, `name`, `team_id`) Slack sends as null still lands on its message's `Interactions`, the null fields left out. Before, the press failed to parse and was dropped without a word.
