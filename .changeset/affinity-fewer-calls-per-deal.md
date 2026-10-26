---
"@listen-fire/affinity": patch
---

Fewer Affinity calls per synced deal, with the same matches, writes and change logs. A deal that matches and changes nothing makes 8 calls (was 10 in process, 26 under `lf`); one that fills a field makes 11 (was 15, 29 under `lf`); a new deal makes 25 (was 27, 45 under `lf`). The saving holds under `lf` with the module-kit release that answers a served module inside its run's scope; searches ask for 50 results instead of 500.

- A list entry the matched organization already carries is not read again when an owner is linked onto it.
- Writing a field value forgets only the cached values of the record it sits on (and its entry), not every record's. Owners, founders and organizations are no longer re-read after another record's write.
- Within a run, one search per term: the matcher's search and a read narrowed by the same term share one request.
- An identity search asks for 50 results, and asks for the first 500 again only when 50 is not the whole answer and holds no record its first rule would pick. The judge still sees every workspace and global candidate it saw before.
- Linking a person to an organization now refreshes that organization's cached record and searches, so a later read of its people in the same run includes them. If the link changes only who the person works for, only the person searches that returned them are refreshed; the others (the team's owners) stay cached.
