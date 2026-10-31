---
"@listen-fire/module-kit": patch
---

An arrival a module reports may carry `occurredAt` (adapter protocol 2.6), when the change happened at its provider, as an ISO 8601 instant. listen-fire's loop breaker measures from it whether a run's write caused the arrival, so an echo a poll finds late is still the write's. Send it wherever your system stamps a time; one that is not an instant is refused, naming the arrival's place and edge.
