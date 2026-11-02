---
'@listen-fire/slack': patch
---

The handbook section and the `Buttons` description read a press's value with `only(press-[:Actions]->)?.Value`, as the 0.14 language requires: `only(…)` may find nothing, and a field is read through it with `?.`.
