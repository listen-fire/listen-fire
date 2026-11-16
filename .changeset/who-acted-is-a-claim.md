---
'@listen-fire/module-kit': minor
'@listen-fire/email': minor
---

Hosts from 0.16 no longer ask a module who acted (adapter protocol 2.10). `@listen-fire/email` no longer offers `getActorCandidates` or `extractActor`; its arrivals still name their sender (`actor`), and it publishes no claim until the email provider rework adds `Verified From`. `module-kit` no longer lists the two methods among those an in-process module may answer, and carries a manifest's `listensLimitedBefore` (the release before which a host may have let only registered senders set a listen on the module off) onto the manifest it serves.
