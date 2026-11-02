---
"@listen-fire/engine": patch
"@listen-fire/engine-contracts": patch
---

`RemoteAdapter.preprocessInbound` is typed as what the wire answers, `{ events, arrivals?, checkpoint? }`, not only the 0.12 events. `engine-contracts` exports the answer as `PreprocessedInbound`, and `Adapter.preprocessInbound` returns it.
