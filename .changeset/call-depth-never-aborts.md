---
'@listen-fire/movement-lang': patch
'@listen-fire/engine': patch
'@listen-fire/engine-contracts': patch
---

The engine's artifact carries the deep-recursion fix: a value nested past 3,000 levels is refused as it crosses to the host, by name, where the engine ran out of stack before.
