---
"@listen-fire/engine-contracts": minor
"@listen-fire/movement-lang": minor
---

A field's capability may declare `containsAny`: the module takes an OR of `CONTAINS` on the field, matching any of the values. The checker hands such an OR to the module (adapter protocol 2.6's `filter`) as it does an OR of `==` on a field declaring `in`.
