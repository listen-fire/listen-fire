# @listen-fire/affinity

## 0.13.1

### Patch Changes

- 22995c3: A record's change carries the changed field's value and says how it changed, as Airtable's changes carry theirs. `Field Change` is `set`, `changed` or `cleared` (a field value's `created`, `updated` and `deleted` events). `Current` is the record holding only the changed field, at the value set or changed to, and `Previous` at the value cleared, each typed by the record's own field (a dropdown by its label; a field holding several values, as the list of the one value added or removed). Affinity sends no value a change replaced, so `Previous` is unknown on a `changed` change. A field the record type does not name marks `Field`, `Current` and `Previous` unknown, so a filter on them is undecided (an `Arrival Not Judged`) where `c.Field == null` passed it. An opportunity list's scalar columns are its entries' fields, read from the workspace's whole field catalog, read-only; its change names them, its `Field` still text as 0.13.0 typed it. The upgrade note on `organization.updated` offers ``AND c.`Field Change` == null``.
- 8e06e5a: A change to an entry of an opportunity list finds its list: a column's list is looked up in the workspace's whole field catalog, where only the organizations' and people's were searched. A list entry's change whose list still cannot be named (a list the connection cannot see, or one made since its lists were read) arrives stating no record type, its `Field` unknown, so each listen on `Changes` it could be for reports it could not judge it (`Arrival Not Judged`), and `listen-fire listens replay` puts it through again; since 0.13 it ran nothing without a word.
- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.13.0

### Minor Changes

- e89fed3: Affinity is listened to on a record's `Changes` (``listen to crm-[:`List Entry — Master Deals List`]->-[c:Changes WHERE c.Field == "Status"]-> fire f``, ``function f(c: <crm-[:`List Entry Change — Master Deals List`]->>)``): an organization's, a person's, an opportunity's and each list's entries', each their own record type (`OrganizationChange`, `PersonChange`, `OpportunityChange`, `List Entry Change — <list>`) with `Kind` (`created`, `updated`, `deleted`) and, when a field's value was set or cleared, `Field`, the field's name as its record shows it (an enum of the record's own fields). A webhook delivery is the arrival on the changed record's `Changes`, carrying the record as Affinity holds it now, `about` it and `occurredAt`; a redelivery of the same change runs nothing. One webhook per connection serves every listen on `Changes` (`ensureEventSubscription({ edge: "Changes" })`). A run can wait on a record's next change: `awaitKeys` keys it by the kind of record and its id (`organization:13`), as each arrival is keyed, since Affinity numbers organizations, persons, opportunities and list entries apart; it needs the head's `recordType`, which a 2.6 host names. It declares how a 0.12 `listen to crm { events: [...] }` naming an organization's, a person's or an opportunity's events becomes a listen on its `Changes` (`listenSettingsBecome`); one naming a list entry's, a field value's, a note's or a reminder's event, or none, has no rewrite. Adapter protocol 2.6. `subscribableEvents` is gone, and notes and reminders no longer run anything.

### Patch Changes

- c67d9a6: A root a listen can start at counts as backed by being `listenable`, where it read the retired `fires`, which the catalog no longer carries.
- c4af6cc: `listen-fire upgrade` never applies a rewrite that hears otherwise than the 0.12 listen did, unasked. Affinity: a listen naming `organization.updated` (or a person's or an opportunity's) is told that `Kind == "updated"` also hears each field value set or cleared on the record, which 0.12 heard only as field_value events, with the remedy `AND c.Field == null`, and is rewritten only under `--all`. Slack: a `message` or `app_mention` listen heard thread replies too, which now arrive on their root message's `Replies`, so it has no rewrite and is told to write one listen for each edge; a `reaction_added` listen is still rewritten onto `Reactions`. GitHub: `participating: false` heard every thread in 0.12, so it now compares nothing (`participating: true` is still `n.Participating == true`). Gmail: a `label_added` listen is told that a label removed and added again now runs it again, and is rewritten only under `--all`; and a 0.12 program reading `Labels` is warned on the upgrade (`MOV_FIELD_MEANING_CHANGED`) that it holds label names where it held ids.
- Updated dependencies [4c09d6a]
- Updated dependencies [faa7050]
- Updated dependencies [acec0bd]
- Updated dependencies [301dab3]
- Updated dependencies [3c2774e]
- Updated dependencies [dd81bed]
- Updated dependencies [c4af6cc]
- Updated dependencies [a942076]
- Updated dependencies [46efd84]
- Updated dependencies [9520af9]
- Updated dependencies [9e9316c]
- Updated dependencies [5bfc3f2]
- Updated dependencies [66d32d5]
- Updated dependencies [16e3776]
- Updated dependencies [16e3776]
- Updated dependencies [da1a05b]
- Updated dependencies [abc777e]
- Updated dependencies [ad23b9c]
  - @listen-fire/module-kit@0.13.0

## 0.12.7

### Patch Changes

- 8563c6a: Fewer Affinity calls per synced deal, with the same matches, writes and change logs. A deal that matches and changes nothing makes 8 calls (was 10 in process, 26 under `lf`); one that fills a field makes 11 (was 15, 29 under `lf`); a new deal makes 25 (was 27, 45 under `lf`). The saving holds under `lf` with the module-kit release that answers a served module inside its run's scope; searches ask for 50 results instead of 500.
  
  - A list entry the matched organization already carries is not read again when an owner is linked onto it.
  - Writing a field value forgets only the cached values of the record it sits on (and its entry), not every record's. Owners, founders and organizations are no longer re-read after another record's write.
  - Within a run, one search per term: the matcher's search and a read narrowed by the same term share one request.
  - An identity search asks for 50 results, and asks for the first 500 again only when 50 is not the whole answer and holds no record its first rule would pick. The judge still sees every workspace and global candidate it saw before.
  - Linking a person to an organization now refreshes that organization's cached record and searches, so a later read of its people in the same run includes them. If the link changes only who the person works for, only the person searches that returned them are refreshed; the others (the team's owners) stay cached.

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
