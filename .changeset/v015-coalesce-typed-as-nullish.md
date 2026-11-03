---
'@listen-fire/handbook': patch
---

The reference says `coalesce` is typed as TypeScript's `a ?? b`: `coalesce(n, "n/a")` is a number or a text, and is no number (the 0.15 checker's typing).
