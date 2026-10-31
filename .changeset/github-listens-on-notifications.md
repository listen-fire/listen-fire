---
"@listen-fire/github": minor
---

GitHub notifications arrive on the connection's `Notifications` edge, polled every minute (lf.yaml `pollEvery` overrides it for a connection): `listen to gh-[n:Notifications WHERE n.Reason IN ["mention"]]-> fire f`. Each thread new or changed since the last poll arrives once, versioned by its `Updated At`. The module takes `Reason` (`==`, `IN`) and the new `Participating` (`==`, asked of GitHub's `participating` filter) and applies them itself. It declares how a 0.12 `listen to gh { events: [...], participating: true }` becomes it (`listenSettingsBecome`) and no longer declares `subscribableEvents`, `listenConfig`, a `fires` edge or event types. Adapter protocol 2.6.
