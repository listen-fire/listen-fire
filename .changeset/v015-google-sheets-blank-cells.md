---
'@listen-fire/google-sheets': minor
---

Needs the listen-fire 0.15 engine: release this only with listen-fire 0.15.0. Every column of a table is maybe absent on a read, as are a named cell's and an addressed cell's `Value`: a blank cell reads as absent, whether the values API leaves it out (a trailing one) or answers `""` (an inner one). A write still gives a column a value.
