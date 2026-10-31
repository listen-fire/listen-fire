---
"@listen-fire/embed": minor
---

A delivery is one `dispatch` and one store write, as listen-fire keeps it: its arrivals are logged and each run it starts has its trigger's waits opened from the mark before them, so a later item of the same delivery answers a run's `await new` and the trigger never answers its own; the runs its arrivals woke step on in the same call. `arrive` is gone. A listen runs an arrival once: its receipt is taken in the write that starts its run, so a redelivery runs nothing, and a `Delivery.id` already kept runs nothing at all. The store's `runHost` must also serve `keepDelivery` and `startArrivalRun` (`memoryRunHostStore` does). A saved program the host cannot read (saved before 0.13, or pinned to 0.12) runs nothing, said with the remedy, and the others still run; a listen a save would refuse runs nothing when a store holds it all the same, said. Each program is read once by its content.
