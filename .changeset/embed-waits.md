---
"@listen-fire/embed": minor
---

A run that awaits a module's listenable edge parks until something lands there: `arrive(tenant, { adapterType, arrivals })` hands the host what one of the tenant's modules says arrived (adapter protocol 2.5), and each of the tenant's runs waiting on it steps on. `tick` steps runs an arrival woke, runs whose timer is due, and runs that owe a race an earlier step left unsettled. An arrival no run waits on yet is kept for an hour, for a run that starts waiting on its record. A step whose last write finds the run taken over by another process leaves the run parked, and its row retries for the run's next holder; a row for a run no longer parked steps nothing. It needs `@listen-fire/engine` and `@listen-fire/engine-contracts` 0.13.0 (the run host's waits).
