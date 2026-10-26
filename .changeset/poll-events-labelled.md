---
"@listen-fire/engine": patch
---

Adapter protocol 2.3: a polled source labels each event with its kind (`eventType`), as a pushed event is, and `lf` narrows a polled listen's `events` by it. A poll event with no label (a module older than 2.3) still reaches the listen that polled it, and `lf` says so once per module per process. `PROTOCOL_MINOR` is 3; 2.3 shows in no manifest, so a module states it (`protocolMinor: 3`). A poll's `movementId` is the listen's pipeline, `listen:<file>:<movement>`. `LF_SECRET__<ENTRY>__MODULE=<module>` makes an entry from the environment that module's install, as `module:` does in the secrets file.
