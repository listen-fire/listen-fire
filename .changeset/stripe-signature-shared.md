---
"@listen-fire/module-kit": patch
"@listen-fire/webhook": patch
---

Stripe's webhook signature check moves into module-kit (`verifyStripeSignature`, `stripeSignature`), so every module that takes Stripe's deliveries checks them one way. `@lf/webhook`'s `stripe` scheme now calls it and behaves as before: the `Stripe-Signature` header's `v1` HMAC of `<t>.<body>`, any of several `v1`s, and a signature older than five minutes refused.

`@lf/webhook`'s handbook section and README point a Stripe sender to `@lf/stripe`, which types its events, objects and amounts.
