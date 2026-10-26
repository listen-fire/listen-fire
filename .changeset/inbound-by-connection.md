---
"@listen-fire/engine": patch
---

Under `lf`, two connections of one module (`a = connect attio using AttioA`, `b = connect attio using AttioB`) no longer share inbound events. A delivery to a connection's door (`/api/public/webhook-sync/<provider>/<credential>`, `/hooks/<external>/<credential>`) runs only the listens whose construction names that credential, and listens whose construction names none. A delivery to the module's own install still reaches every listen. `lf serve` registers a webhook per connection, as that connection's credential, for that connection's listens' events; a credential no listen uses has its webhook removed. A polled listen polls as its own connection's credential. A queued event row from before this release reaches every listen, as it did.
