---
"@listen-fire/module-kit": patch
---

Adapter protocol 2.5, arrivals: an adapter with listenable edges offers `arrivals: { awaitKeys }`, and the kit's server lists and answers `awaitKeys` (still stating 2.0). `accepted(events, { arrivals })` reports what a checked request says landed on listenable edges; `preprocessInbound` may answer `arrivals` beside its events. An in-process module's `awaitKeys` answers are validated like its other answers.
