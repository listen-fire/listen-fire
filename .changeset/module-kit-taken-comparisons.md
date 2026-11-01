---
"@listen-fire/module-kit": minor
---

`takenComparisons(filter)` reads the part of a listen's WHERE a polled module takes (adapter protocol 2.6's `filter`) as comparisons, `narrowedTo` names the texts an `==` or `IN` narrows to, and `holds` judges a field as the engine does, so a module can apply what its provider cannot and say `takenApplied: true`.

An OR of `CONTAINS` on one field (a field declaring `containsAny`) reads as a `containsAny` comparison, which `holds` judges as any of its values contained.
