---
'@listen-fire/gmail': patch
'@listen-fire/engine-contracts': patch
---

A field that declares `changedIn` may also declare `unchangedValues`, the values that mean what they always did. A check for an upgrade does not warn (`MOV_FIELD_MEANING_CHANGED`) where a program compares the field only with literals among them (`==`, `!=`, `CONTAINS`, `IN`); the checker compares the literal with the list and reads nothing into its spelling. Gmail declares its own labels (`INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`, `SENT`, `DRAFT`, `SPAM`, `TRASH`, `CHAT`, the five `CATEGORY_` tabs) for `Labels`, so a 0.12 listen on `INBOX` upgrades and moves the pin without `--all`, while one on a custom label's id still holds it.
