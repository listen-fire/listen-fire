---
"@listen-fire/authoring-mcp": patch
---

A save's warning that some listens do not check counts the listen statements the check refused, as its answer names them (`unwatched`). It counted written listens against plans, which hid a refused listen once another listen, written over a union, came to a plan per member.
