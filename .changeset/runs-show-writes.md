---
"@listen-fire/engine": patch
---

`lf runs show --json` says when a run finished (`finishedAt`, beside `startedAt`; `null` while it runs or is parked) and lists its writes (`writeRecords`): each one's target (adapter, record type, record id), action (`create`, `update`, `delete`, `link`, …), whether it was committed, and the values it set, capped at 2 KiB each and the first 100 writes. `lf runs --json` shows `finishedAt` too. A run's `writes` now counts every entry into it: after a resume it was only the resumed entry's. The human output still prints counts. A store module may answer `finishedAt` on a run row; it is optional, as is `writeRecords` in a run's outcome.
