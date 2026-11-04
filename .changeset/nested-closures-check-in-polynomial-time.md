---
"@listen-fire/movement-lang": patch
---

Checking a movement of nested closures no longer doubles in time with each level: forty nested `map` closures, near the grammar's nesting limit, check in under a second, where twenty took a minute. Which programs are accepted and every diagnostic are unchanged.
