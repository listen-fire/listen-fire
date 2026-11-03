---
'@listen-fire/handbook': patch
---

The reference and the expressions chapter say what `coalesce` answers as it runs: the first argument that has a value, as TypeScript's `??`. An empty text is a value, so `coalesce(pr.Body, pr.Title)` answers an empty body. The reference said "first non-empty".
