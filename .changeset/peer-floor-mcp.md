---
"@listen-fire/mcp": patch
---

The core peer floor is now `>=0.13.1`. The handbook section's examples connects a module with no import, which 0.13.0 does not read, so a 0.13.0 host installed it cleanly and then failed on its examples.
