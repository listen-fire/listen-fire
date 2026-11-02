---
"@listen-fire/module-kit": patch
---

`firedRecordFields(event)`: the fields of the record that landed on the arrival a run was fired on, as its module put them on the landing; none for a run no arrival fired. A module's `extractActor` and `getActorCandidates` read the actor from these, since no 0.13 run's event carries a `payload`.
