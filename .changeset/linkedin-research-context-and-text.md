---
'@listen-fire/engine': patch
---

The `linkedin-research` signature gains an optional `context` input, which is text the caller already has about the person: it guides the search and is never evidence alone. It also gains an optional `activity_text` output, the passages found about the person, each under its source address. Both are additions, so existing programs check and run as written.
