---
"@listen-fire/movement-lang": patch
---

Runners sharing a secrets module share each webhook: registering never replaces or narrows it, and the last holder to leave removes it. A call to a secrets module now fails after 60 s (`LF_SECRETS_CALL_TIMEOUT_MS`) instead of freezing the process, and a token refresh keeps a rotated token when only `webhook_holders` moved during it.
