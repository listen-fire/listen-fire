---
'@listen-fire/handbook': minor
---

The handbook teaches `x?.F`, a field read through a value that may be missing (absent when it is), and refuses `.` there as the 0.14 language does: through `only(…)`, `first(…)`, `extractOne(…)`, a named `match`, a call's result and an index read. A presence test of a record that may be missing is `exists(x)` or `x?.F != null`; `exists(xs[0])` proves every later `xs[0]`. Every example reads that way.
