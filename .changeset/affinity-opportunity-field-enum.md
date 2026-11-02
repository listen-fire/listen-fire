---
"@listen-fire/affinity": minor
---

Needs the listen-fire 0.14 engine: release this only with listen-fire 0.14.0. An opportunity list's change `Field` is an enum of the list's columns, as every other list's is: a listen naming a value that is not one of them is refused (`MOV_ENUM_UNKNOWN_VALUE`), where 0.13 typed it as text. Under a 0.13 engine this would refuse a program that checked before, which is why it ships with the 0.14 compatibility key and not within 0.13.
