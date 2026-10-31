---
"@listen-fire/module-kit": patch
---

A module's manifest may declare `listenSettingsBecome`: how its 0.12 settings listens (`listen to gh { events: ["mention"] }`) become 0.13 traversals (`listen to gh-[n:Notifications WHERE n.Reason IN ["mention"]]->`), so `listen-fire upgrade` rewrites them. module-kit serves it in the manifest as declared; the host refuses, when the module is described, a path naming an edge the module does not describe, a key mapped past the path, or a comparison naming no field.
