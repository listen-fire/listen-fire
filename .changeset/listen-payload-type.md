---
"@listen-fire/engine": patch
---

A listen can declare what its events are, as a node the program declares: `listen to stripe { payload: <Payment> } fire f`, for a module whose listen-config key has the new catalog format `type` (`@lf/webhook`'s `payload`). The movement it fires is checked against that node field by field, and reads in its body are checked against it. Under `lf`, an event whose payload does not fit the node fires nothing, and a delivery none of whose listens it fits is answered 400 `payload_mismatch`, naming the fields. The engine holds a parameter typed by a declared node as the event's payload, so `e.amount` reads the body. Additive: it accepts only text refused before.

Under `lf`, a `payload:` node imported from another movement file (`import { Payment } from "types"`) now gates deliveries the way one declared in the same file does; before, such a listen took any body.
