---
'@listen-fire/movement-lang': patch
'@listen-fire/engine': patch
'@listen-fire/engine-contracts': patch
---

The engine's artifact carries the deep-recursion fix. A run that goes deeper than the WASM engine's stack holds ends with `CallDepthExceeded` (`MOVENG_CALL_DEPTH`, `stackRanOut: true`, its message saying the engine's stack ran out) where it crashed before, on the engine's own check or, when V8's stack runs out first, by the host. `movement-lang` exports `EngineStackRanOut`, what an engine segment throws for the second. The shadow stack goes from 2 MiB to 3 MiB, so whatever fitted before still does.

A value nested past 3,000 levels is refused as it crosses to the host, by name. This ships in a patch and not under a new compatibility key: the rule about a tightened engine rule does not apply, since the cap refuses only what crashed before.
