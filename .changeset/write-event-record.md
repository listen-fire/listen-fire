---
"@listen-fire/engine": patch
---

A write to the movement's event parameter (`write company { … }` in `function onboard(company: <crm-[:Company]->>)`) updates the record the event fired on, through the module's `updateRecord`, as a write to a traversal alias does; `delete company` deletes it. It checked clean before but failed every run (`MOVENG_RUNTIME: 'company' is the movement parameter (the event position) …`), under `lf` and the embedded host alike. The event must name its record (an id and an event type the module lists), else the run says it has no stable record to update.
