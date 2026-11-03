---
"@listen-fire/handbook": patch
---

The core peer floor is now `>=0.15.0`. The handbook's `patterns#group-and-count` recipe and its built-ins reference use `Dict.keys` and `List.distinct`, which a 0.14 core does not read, so a 0.14 host would install it cleanly and then fail on those examples.
