---
"@listen-fire/airtable": patch
"@listen-fire/module-kit": patch
---

Airtable refusing a credential fails the call at once, where before every failure was retried as if transient, for over two minutes, saying nothing (`listen-fire check` with a placeholder token hung). A 401 is refreshed once where the host can, then answered as `credential_refused`, naming what Airtable said. Any other status no retry can change (a 403, a 404, a 422) fails at once, naming the status. Only a 429, a 5xx or a network error is sent again, through module-kit's shared `retryingFetch`: at most 5 attempts within 45 s of waiting, a 429 waiting Airtable's documented 30 s penalty, and then a failure naming the status, the attempts and the wait.

module-kit: `CredentialRefusedError`, thrown by a module served through the kit, answers the protocol's `credential_refused` (not retryable), on which the calling host refreshes the credential and retries the call once. `retryingFetch` takes `rateLimitWaitMs`, the wait before retrying a 429 that names no Retry-After.
