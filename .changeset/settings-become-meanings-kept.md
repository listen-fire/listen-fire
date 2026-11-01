---
"@listen-fire/affinity": patch
"@listen-fire/slack": patch
"@listen-fire/github": patch
"@listen-fire/gmail": patch
---

`listen-fire upgrade` never applies a rewrite that hears otherwise than the 0.12 listen did, unasked. Affinity: a listen naming `organization.updated` (or a person's or an opportunity's) is told that `Kind == "updated"` also hears each field value set or cleared on the record, which 0.12 heard only as field_value events, with the remedy `AND c.Field == null`, and is rewritten only under `--all`. Slack: a `message` or `app_mention` listen heard thread replies too, which now arrive on their root message's `Replies`, so it has no rewrite and is told to write one listen for each edge; a `reaction_added` listen is still rewritten onto `Reactions`. GitHub: `participating: false` heard every thread in 0.12, so it now compares nothing (`participating: true` is still `n.Participating == true`). Gmail: a `label_added` listen is told that a label removed and added again now runs it again, and is rewritten only under `--all`; and a 0.12 program reading `Labels` is warned on the upgrade (`MOV_FIELD_MEANING_CHANGED`) that it holds label names where it held ids.
