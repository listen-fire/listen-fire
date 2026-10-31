---
"@listen-fire/email": minor
---

Inbound mail arrives on the connection's `Emails` edge, each message with the plus-suffix it was sent to as its `Key` (lowercased; the empty key for mail to the box itself): `listen to inbox-[e:Emails WHERE e.Key == "deals"]-> fire f`. `Emails` is unbounded, narrowed by `Key`, an `InboxKey` a listen writes lowercase, with the characters a plus-suffix can carry (`""` for the box itself). The module declares how a 0.12 `listen to inbox { key: "deals" }` becomes it (`listenSettingsBecome`; a listen with no key becomes `e.Key == ""`, and a key is lowercased, as 0.12 compared it), and no longer declares `listenConfig`, a `fires` edge or event types. Adapter protocol 2.6.
