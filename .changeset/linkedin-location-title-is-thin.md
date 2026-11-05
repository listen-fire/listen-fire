---
'@listen-fire/web': patch
---

An index title that gives only a location, such as `Jane Doe - Sverige | Yrkesprofil`, no longer counts as the person's role. `linkedin-research` now reads the profile for such a person, and a location is told to the planner and the synthesiser as a location. A result that rests on the index alone reports low confidence, and `current_role` no longer falls back to the title's text. The `Nothing consistent with the headline` log line now lists the title and address of each search result it was given.
