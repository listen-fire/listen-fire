---
"@listen-fire/airtable": patch
---

An Airtable single or multiple select field now publishes the base's choices as an enum, so a program that writes or compares a value the base does not have is refused (`MOV_ENUM_UNKNOWN_VALUE`). A select with no choices listed stays text.
