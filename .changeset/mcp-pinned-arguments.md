---
"@listen-fire/mcp": patch
---

A read-only tool's required arguments are marked `pinned`, so `lf check` refuses a read that does not pin one in its `WHERE` with `==` (`MOV_HOP_PIN_REQUIRED`, naming the argument) instead of the run failing. The run still names a required argument that reaches the server without a value.
