---
'@listen-fire/movement-lang': minor
'@listen-fire/handbook': patch
---

`Dict.keys(d)`, `Dict.values(d)` and `Dict.entries(d)` list a dict (a `List.groupBy` or `List.keyBy` answer, or a `{ … }` literal), in no order, and `List.distinct(list)` answers each plain value once, in the order they first appear. The wasm carries them, and the standard library table names the new `dict` parameter type. The handbook's `patterns#group-and-count` groups one level with `List.groupBy` and `sort(Dict.keys(by))`, and keeps the run's own graph for grouping deeper than one level; the expressions chapter and the reference name the four functions, and the reference lists `Dict` among the words that can't be names.

`Date.daysBetween(from, to)` answers the whole calendar days from one date to another, negative when `to` is the earlier; a datetime counts as its day in UTC. It is `number | absent` when either argument may be absent or is text. The wasm carries it; the builtins, expressions and reference chapters name it, and the micro examples answer "days between two dates" with it.
