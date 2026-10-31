---
"@listen-fire/handbook": patch
---

The reviews chapter's `deleted-records` says a record deleted while a run waits on it leaves the wait waiting, and to race every wait on a person or a system with a `sleep`; the reference's waiting section and its pitfalls say the same. Before, they said the wait settled empty and the code after it ran zero times, and that an `all` slot or a `map` member that awaits could be null.
