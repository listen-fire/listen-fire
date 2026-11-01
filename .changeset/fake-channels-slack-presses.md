---
"@listen-fire/fake-channels": minor
---

The fake Slack builds a press as Slack posts it (`POST /slack/control/press`): the `block_actions` payload carries the message pressed with its blocks, and the action as its button was posted (its block id). It answers `auth.test` with its bot user, and logs every Web API method called (`/admin/slack/request_log/state`), so a test can say a call was never made. An outage makes the methods it names answer 500 until cleared (`POST /slack/control/outage { methods }`). A posted message's `ts` is seconds, a point and six digits, as Slack writes it (it was malformed, so its `Timestamp` read as no instant). The fake Airtable's record list honours `filterByFormula`'s equalities (`AND`, `OR`, `{Field} = "…"`, `RECORD_ID() = "…"`), so a `unique by` write finds its own row.
