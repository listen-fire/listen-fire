---
"@listen-fire/module-kit": minor
---

`ctx.records`: the host's records door, facts about its own runs and waits (docs/contracts/system-events.md), read as `ctx.records.read(method, params)`. serve-module reaches it at `LF_HOST_URL` under `LF_HOST_TOKEN`, as it reaches the models and OCR doors (`hostRecords`); a host that serves none refuses a read by name (`refusingRecords`, the in-process default).
