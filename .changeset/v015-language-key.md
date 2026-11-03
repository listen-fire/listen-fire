---
'@listen-fire/movement-lang': minor
'@listen-fire/engine': minor
'@listen-fire/engine-contracts': minor
---

0.15.0, a new compatibility key: a word an expression reads as itself is never a name, `coalesce` is typed as `a ?? b`, a `List.groupBy` or `List.keyBy` key that may be absent is refused, `first`, `[0]`, `Text.join` and `reduce` over the records an unordered walk's block answers, or over a list literal spreading them, are refused, and a built-in inside walk brackets is spelled as outside them (`LENGTH` of a list there as `count(xs)`). The engine package's schema projection types a field a record may not hold (`mayBeAbsent`) as `T | null` where it is read and `T` where it is written. A pin of `0.14.x` is refused by name ("validate it under 0.15.0 and upgrade it"). The wasm artifacts are rebuilt.
