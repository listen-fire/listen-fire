---
"@listen-fire/module-kit": patch
"@listen-fire/engine-contracts": patch
---

`holds` decides a taken comparison exactly as the engine's judge does, so a module that applies the taken part itself and says `takenApplied` never drops an arrival the host would fire: numeric texts order as numbers (`"100" > "20"`, `"5" > 3`), dates are ISO texts only and one with no offset is UTC (`"Mar 5, 2024"` orders as text), lists are equal as sets of their distinct members, `== null` holds for an absent field and `!= null` fails for one, and `==` is strict. An OR with `== null` is no longer read as an `IN` list: `takenComparisons` leaves it to the host. Both are held to `conformance/taken-comparisons.json`, which the engine's Rust runs too.
