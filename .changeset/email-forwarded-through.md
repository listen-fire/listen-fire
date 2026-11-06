---
"@listen-fire/email": patch
---

An email lands with `Forwarded Through`, a list of text: the inboxes its forwarding headers name (`X-Forwarded-For`, `Delivered-To` and the like), lower case, empty when none. The address it was finally sent to is not one.
