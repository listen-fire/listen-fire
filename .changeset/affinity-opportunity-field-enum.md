---
"@listen-fire/affinity": patch
---

(0.14) An opportunity list's change `Field` is an enum of the list's columns, as every other list's is: a listen naming a value that is not one of them is refused (`MOV_ENUM_UNKNOWN_VALUE`), where 0.13 typed it as text.
