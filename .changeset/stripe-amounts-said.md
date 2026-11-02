---
"@listen-fire/stripe": patch
---

A customer's, an invoice's and a charge's description now says in its first sentence that their amounts are in major units of their `Currency` (490 usd is $490, not cents). The first sentence is what `listen-fire catalog`, `listen-fire runs show` and `listen-fire modules show` print for a record type, so a reader of any of them sees it beside the numbers. The amounts themselves are unchanged.
