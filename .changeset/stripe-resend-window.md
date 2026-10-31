---
'@listen-fire/stripe': patch
---

`@lf/stripe` declares a re-send window of three days (`resendWindowSeconds`), as long as Stripe retries an undelivered event: a host keeps each event's identity that long, so a retry after the arrival log forgot the event is still a repeat.
