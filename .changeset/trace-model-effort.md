---
"@listen-fire/engine": patch
---

A run's trace names how each model call was asked: an extraction's entry and an `ai()` call's entry carry the `tier` written (`null` for none), the `model` and its `effort`. The tiers share one model and differ in effort, so `quick` and `careful` looked identical in a trace. The TypeScript shim reads both members, and still reads an entry from an artifact that names neither.
