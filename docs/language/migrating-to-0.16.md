# Migrating to 0.16

0.16.0 opens a new compatibility key: it reads pins of `0.16.x` only. A project pinned to `0.15.x` is refused by name until it is upgraded, and `listen-fire upgrade` moves its pin once every file checks clean.

One idea runs through the release: **who acted is a claim, and the filter decides.** A module publishes who sent or pressed something as a typed field. A host answers what that means to its team through functions a listen's filter calls. `Actor` and the acting-user meta values are gone, and so is any host gate outside the text.

## Contents

- [1. How the pin moves](#1-how-the-pin-moves)
- [2. Claims and brands](#2-claims-and-brands)
- [3. Host functions in a filter](#3-host-functions-in-a-filter)
- [4. Actor and the acting user are retired](#4-actor-and-the-acting-user-are-retired)
- [5. Slack's own messages](#5-slacks-own-messages)
- [6. The open listen](#6-the-open-listen)
- [7. A whole program](#7-a-whole-program)
- [8. Diagnostic code index](#8-diagnostic-code-index)

## 1. How the pin moves

- `listen-fire upgrade` checks every movement file as a move up from its pin. Nothing in this release is rewritten unasked; each change is a refusal or a warning the author answers.
- The pin (`engine:` in `lf.yaml`) moves to `0.16.0` only when every file checks clean and the warnings in section 6 are answered. `listen-fire upgrade --all` moves it once the author has checked.
- A host function's answer in a run is as of the run, and may differ from what the filter saw at the door.

## 2. Claims and brands

A module's field can carry a brand: `text & Brand<"claim:email/address">`. The brand says the module vouches for the value. A function that asks for a claim refuses plain text (`MOV_BRAND_REQUIRED`).

| 0.15 | 0.16 |
|---|---|
| `e.Actor?.Email` | `` m.`User Email` `` (Slack), `` m.`Sender Email` `` (Telegram), `` n.`Note Owner Email` `` (Granola) |
| `e.Actor?.Phone` | `` m.`Sender Phone` `` (WhatsApp) |
| `e.Actor?.Id` | `` c.`Changed By` `` (Attio) |

The fields and their forms are in [`contracts/claims.md`](../contracts/claims.md). Email publishes none: its `From` is plain text, and a function that asks for a claim refuses it.

## 3. Host functions in a filter

A listen's filter, and a wait's `WHERE`, may call a pure function: a built-in that reads no clock, model or source, or a function a plugin package declares pure. A host offers its functions as a plugin package, imported like any plugin. Which it offers is its own choice; the platform's `@lf-platform/team` offers `isMember` and `userFor`.

| 0.15 | 0.16 |
|---|---|
| `e.Actor?.Domain == "acme.test"` | `` Text.regexExtract(m.`User Email`, "@([^@]+)$", 1) == "acme.test" `` |
| a host's registered-member gate | `` team.isMember(m.`User Email`) `` in the filter |

- A value that may be missing is narrowed first: `` m.`User Email` != null AND team.isMember(m.`User Email`) ``.
- Terms that need no host are written first. The host is called only for a sender they let through, and each answer is kept.
- A host that cannot be reached leaves the arrival unjudged; nothing runs until it is judged.
- Any other call in a filter is refused, naming why (`MOV_LISTEN_IMPURE_WHERE`, `MOV_AWAIT_IMPURE_WHERE`). `fail(…)` is impure there.
- `x.f(…)` off a name that is not an imported package or a standard namespace is refused (`MOV_FUNCTION_UNKNOWN`).

## 4. Actor and the acting user are retired

| 0.15 | 0.16 |
|---|---|
| `m.Actor?.Email` on a record that declares no `Actor` | refused (`MOV_ACTOR_RETIRED`), naming the claims that record has |
| `@user_email`, `@user_name`, `@user_id`, `@actor_email`, `@actor_name`, `@actor_id` | refused (`MOV_ACTING_USER_RETIRED`), naming claims and host functions |

Neither has a rewrite: the old values have no exact replacement. Read the claim off the event, and when the run needs the person, ask a host function (`` team.userFor(m.`User Email`)?.Level == "admin" ``). A module's own field called `Actor` reads as before.

A host serves host families version 3, which has no `lookup.resolveActingUser`. Adapter protocol 2.10: hosts stop calling `getActorCandidates` and `extractActor`, and a module's arrivals carry no `actor`.

## 5. Slack's own messages

The `drop_own_messages` connection setting is refused (it lived in the connection's settings, so no upgrade can rewrite it). The listen says it instead:

| 0.15 | 0.16 |
|---|---|
| `drop_own_messages: true` on the connection | `` WHERE NOT m.`Sent By This App` `` on each listen |

`Sent By This App` is false when Slack does not say who the app is.

## 6. The open listen

Before 0.16 a host may have let only registered team members set a Slack listen off. Under 0.16 only the listen's filter decides. An upgrade tells each Slack listen whose filter calls no pure function on a claim (`MOV_LISTEN_NOW_OPEN`, a warning): it names the claims the event carries, and `` NOT m.`Sent By This App` ``. The pin stays until `listen-fire upgrade --all`.

| 0.15, team limited by the host | 0.16 |
|---|---|
| `` listen to slack-[m:Messages WHERE m.Channel == "C0DEALS"]-> fire intake `` | `` … WHERE m.Channel == "C0DEALS" AND team.isMember(m.`User Email`) `` with `import { `@lf-platform/team` as team } from plugins` |

If anyone may set it off, the listen stays as it is and `--all` accepts it. A host that knows its limiting function passes it to the check, and the warning then carries a fix to review; nothing is inserted unasked. A file written under 0.16 is told nothing.

## 7. A whole program

A Slack intake only the team can set off, leaving out the app's own posts:

```
import { `@lf-platform/team` as team } from plugins
slack = connect `@lf/slack` using team_workspace

function intake(m: <slack-[:Message]->>) {
  write m-[:Reactions]-> { Emoji: "eyes" }
}

listen to slack-[ch:Channels WHERE ch.Name == "dealflow"]->-[m:Messages WHERE NOT m.`Sent By This App` AND team.isMember(m.`User Email`)]-> fire intake
```

## 8. Diagnostic code index

Codes keep their names across releases; only their texts change.

| code | what 0.16 reports |
|---|---|
| `MOV_BRAND_REQUIRED` | plain text where a claim is asked for |
| `MOV_ACTOR_RETIRED` | `Actor` read off a record that declares no such field |
| `MOV_ACTING_USER_RETIRED` | `@user_*` or `@actor_*` |
| `MOV_LISTEN_NOW_OPEN` | a Slack listen no longer limited by its host (warning, holds the pin) |
| `MOV_LISTEN_IMPURE_WHERE`, `MOV_AWAIT_IMPURE_WHERE` | a call in a filter or a wait's `WHERE` that is not pure |
| `MOV_ABSENT_REQUIRED` | a claim that may be missing, passed unnarrowed |
| `MOV_FUNCTION_UNKNOWN` | a dotted call off a name that is no package or namespace |
