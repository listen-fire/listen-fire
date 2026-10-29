---
"@listen-fire/web": patch
---

A gated document source no longer waits for the share page's `load` event, which a viewer's trackers can hold open past the navigation timeout and so lose a deck already on screen. Navigation waits for the DOM, then for the source's own sign that it has rendered: DocSend waits for its email gate, its Spaces gate or listing, its viewer, or a hand-off to another site, and fails naming that when none appears in 30 s; a source without its own signal gives `load` 30 s and carries on without it.
