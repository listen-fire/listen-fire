---
'@listen-fire/handbook': minor
'@listen-fire/authoring-mcp': patch
---

The handbook carries the chapters on the always-connected `cron` and `manual` (`system:cron`, `system:manual`, exported as `UNIT_CHAPTERS`). Its index and `listen-fire catalog` route a schedule's or a hand-started run's author to them, and only the platform had them: elsewhere the route answered "No chapter". `system:cron` shows a schedule listen in a zone and says what a tick carries (`Fired at`, `Schedule`, `Zone`); `system:manual`, a start reading its `Text`, and a backfill. Each example checks clean. The authoring tools read them with no host; a host's own chapter of the same id takes their place.
