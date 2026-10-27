---
"@listen-fire/airtable": patch
---

The listen description says a `field`/`becomes` listen's movement must name its table in the signature (`<hiring-[:`Record Change` WHERE `table` == "tbl…"]->>`), which `lf check` now requires: the event is narrowed only by the address the signature names. Additive to the field-change listen, new in this unreleased cycle.
