---
'@listen-fire/movement-lang': minor
'@listen-fire/handbook': patch
---

`Dict.keys(d)`, `Dict.values(d)` and `Dict.entries(d)` list a dict (a `List.groupBy` or `List.keyBy` answer, or a `{ … }` literal), in no order, and `List.distinct(list)` answers each plain value once, in the order they first appear. The wasm carries them, and the standard library table names the new `dict` parameter type. The handbook's `patterns#group-and-count` groups one level with `List.groupBy` and `sort(Dict.keys(by))`, and keeps the run's own graph for grouping deeper than one level; the expressions chapter and the reference name the four functions, and the reference lists `Dict` among the words that can't be names.
