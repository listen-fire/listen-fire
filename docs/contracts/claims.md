# Claims

A claim is a field of what landed whose type carries a brand, saying a module vouches for the value as a way to identify someone. This page is the convention: the names, the form of each value, and who publishes what. It is not a versioned contract; a claim is an ordinary field in the catalog, in the shape the [catalog snapshot](catalog-snapshot.md) already has.

## The type

`text & Brand<"claim:email/address">`, or `number & Brand<"claim:github/user_id">`. A brand's name is compared whole, never parsed.

- A branded value fits wherever its base type is asked for, so `` m.`User Email` == "ada@acme.com" `` checks.
- A function that asks for a brand refuses plain text. Any operation (`Text.lower`, interpolation) returns plain text, and no program can create a branded value.
- A module declares a claim by branding a field in its schema (`brands: ["claim:email/address"]` on the field). A plugin declares the brands its arguments take.

## Names and forms

A module normalises the value before it publishes it.

| claim | value |
|---|---|
| `claim:email/address` | an address, lower case |
| `claim:phone/e164` | a number with the country code first and a leading `+` (`+447700900123`) |
| `claim:<module>/user_id` | the module's own opaque user id (`claim:attio/user_id`) |

## Publishing is vouching

A module publishes a claim only for a value its source vouches for, and leaves the field null when it cannot. A field that can be null is declared so: its type is `text & Brand<"claim:email/address"> | null`. There is no `proven` flag: a branded field is the module's word.

- A lookup that failed leaves the field in the arrival's `unknown` list, so a filter is never judged on a guess.
- A value Slack or Attio does not name as a person (a bot, an API token) is null, not a claim.

## Who publishes what

| module | field | on | claim |
|---|---|---|---|
| Slack | `User Email` | Message, Reaction | `claim:email/address` |
| Slack | `Pressed By Email` | Interaction (a press) | `claim:email/address` |
| Telegram | `Sender Email` | Message | `claim:email/address` |
| WhatsApp | `Sender Phone` | Message, Reaction, Location | `claim:phone/e164` |
| Granola | `Note Owner Email` | Note | `claim:email/address` (never null) |
| Attio | `Changed By` | each object's change type | `claim:attio/user_id` (workspace members only) |

Slack also publishes `Sent By This App`, a plain boolean (not a claim): true on a message or reaction the app itself sent.

Email publishes none. Nothing in a message vouches for its `From` line, so `From` is plain text and a function asking for a claim refuses it.

## What a claim is used for

A host offers functions that take claims, as a plugin package a program imports. `listen-fire` offers none; a host chooses its own (the platform's `@lf-platform/team` offers `isMember` and `userFor`). A pure one may be called in a listen's filter. This example uses one host's package, the platform's; another host offers its own:

```
import { `@lf-platform/team` as team } from plugins
slack = connect `@lf/slack` using team_workspace

function intake(m: <slack-[:Message]->>) {
  write m-[:Reactions]-> { Emoji: "eyes" }
}

listen to slack-[m:Messages WHERE m.`User Email` != null AND team.isMember(m.`User Email`)]-> fire intake
```

A claim that can be null is tested first, as above, because a function refuses a value that may be missing.

See the handbook's listeners chapter, and [`migrating-to-0.16.md`](../language/migrating-to-0.16.md).
