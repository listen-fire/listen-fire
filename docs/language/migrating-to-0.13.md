# Migrating to 0.13

0.13.0 opens a new compatibility key: it reads pins of `0.13.x` only. A project pinned to `0.12.x` is refused by name until it is upgraded, and `listen-fire upgrade` moves its pin once every file checks clean. The [changelog entry](../../CHANGELOG.md) lists each change in a line; this guide shows each one with a program you can run.

One idea runs through the release: **an answer from outside arrives on an edge.** A press arrives on a message's `Interactions`, a form's answer on its `Submissions`, a reply on a thread's `Replies`. A run waits for one by traversing that edge with `await`, as it reads any other edge. The handbook's reviews chapter teaches the forms below in full.

## Contents

- [1. How the pin moves](#1-how-the-pin-moves)
- [2. `await first(x)` is written `await x`](#2-await-firstx-is-written-await-x)
- [3. `callback(…)` is retired](#3-callback-is-retired)
- [4. A wait's `WHERE` keeps the values it read from the run](#4-a-waits-where-keeps-the-values-it-read-from-the-run)
- [5. What a wait binds is always there](#5-what-a-wait-binds-is-always-there)
- [6. Runs parked under 0.12](#6-runs-parked-under-012)
- [7. Modules: `listenable` replaces `awaitable` and `watchable`](#7-modules-listenable-replaces-awaitable-and-watchable)
- [8. Diagnostic code index](#8-diagnostic-code-index)

## 1. How the pin moves

- `listen-fire upgrade` checks every movement file of the project as a move up from its pin, and applies the fixes marked safe. `--check` prints the diff and writes nothing; `--all` also applies the fixes that may change meaning.
- The pin (`engine:` in `lf.yaml`) moves to `0.13.0` only when every file then checks clean. Otherwise it stays, and the command lists what is left to change by hand.
- A change of meaning with nothing to rewrite is a warning: it is listed, and it never holds the pin (section 4).
- Until the pin moves, a 0.13 `listen-fire` refuses the project by name: "this automation pins language 0.12.13, which this release (0.13.0) does not read; validate it under 0.13.0 and upgrade it".

The order that works:

1. Run `listen-fire upgrade --check` and read what it lists.
2. Replace each `callback(…)` by hand (section 3).
3. Run `listen-fire upgrade`. It respells `await first(…)` (section 2), lists the captured values (section 4), and moves the pin. If it lists a wait it cannot respell, rewrite that wait (section 2) and run it again.
4. Delete the `== null` guards after waits (section 5).

## 2. `await first(x)` is written `await x`

A wait pulls exactly one record off one edge, so the bare traversal says it.

| Before | After |
| --- | --- |
| `reply = await first(msg-[:Replies]->)` | `reply = await msg-[:Replies]->` |

- `MOV_V5_SPELLING` carries the rewrite as a safe fix, and `listen-fire upgrade` applies it. It waits for the same one record.
- New in 0.13: `await new msg-[:Replies]->` takes only a reply that arrives after `msg` entered the run, skipping any already in the thread.

Two waits 0.12 accepted are refused once respelled, and the pin holds until each is rewritten by hand:

- **An edge that can be listed but declares no order** (`MOV_AWAIT_UNORDERED`). A plain `await` takes the first match already there, and with no order there is no first. Write `await new`, which waits only for what arrives.
- **A wait at the end of a walk of more than one edge** (`MOV_AWAIT_BARE_WALK`). Bind the record the last edge leaves from, then await that edge off it.

| Before | After |
| --- | --- |
| `c = await first(deal-[:Comments]->)`, where `Comments` declares no order | `c = await new deal-[:Comments]->` |
| `reply = await first(ops-[:Messages]->-[:Replies]->)` | `msg = only(ops-[:Messages]->)`, then `if (msg == null) { fail("no message") }`, then `reply = await msg-[:Replies]->` |

```
import { `@lf/slack` as slack, `@lf/manual` as manual } from adapters
import { team_workspace } from credentials

team = connect slack using team_workspace
runs = connect manual

function `Who Takes It`(go: <runs-[:Invocation]->>) {
  ops = only(team-[ch:Channels WHERE ch.Name == "ops"]->)
  if (ops == null) { fail("no #ops channel") }
  msg = write ops-[:Messages]-> { Message: "Who can take ${go.Text}? Reply in the thread." }

  r = race(
    () => {
      reply = await msg-[:Replies]->
      return reply.Message
    },
    () => { await sleep(1d) },
  )

  if (r[0] == null) {
    write ops-[:Messages]-> { Message: "Nobody picked up ${go.Text}." }
  }
}

listen to runs {} fire `Who Takes It`
```

## 3. `callback(…)` is retired

- Every `callback(…)` is refused where it is written (`MOV_CALLBACK_RETIRED`), naming what replaces it. It has no automatic fix: the replacement depends on how the callback was delivered.
- `listen-fire upgrade` lists each one by file and line, and leaves the pin where it was until each is replaced.
- Why: a callback was a second way for a run to wait, outside the graph. Buttons and a form are records on edges, and a run waits on them like any other edge.

### Buttons: a callback's id on a control

Before, each answer was its own callback, its id carried in Block Kit JSON, and the run awaited each one's `Called` edge.

```
yes = callback({ })
no  = callback({ })
write approvals-[:Messages]-> { Message: "Approve this?", Blocks: [ … ] }   # one control per id
```

After, the buttons are a field of the message, and a press arrives on the message's `Interactions`. The `Value` of the action pressed is one of the values written, so comparing it with one no button offers is refused.

```
import { `@lf/slack` as slack, `@lf/manual` as manual } from adapters
import { team_workspace } from credentials

team = connect slack using team_workspace
runs = connect manual

function `Approve Or Reject`(go: <runs-[:Invocation]->>) {
  approvals = only(team-[ch:Channels WHERE ch.Name == "approvals"]->)
  if (approvals == null) { fail("no #approvals channel") }
  msg = write approvals-[:Messages]-> {
    Message: "Approve ${go.Text}?"
    Buttons: [{ Text: "Approve", Value: "approve" }, { Text: "Reject", Value: "reject" }]
  }

  r = race(
    () => {
      press = await msg-[:Interactions]->
      return only(press-[:Actions]->).Value
    },
    () => { await sleep(1d) },
  )

  if (r[0] == "approve") {
    write msg-[:Replies]-> { Message: "Approved." }
  }
  if (r[0] == null) {
    write msg-[:Replies]-> { Message: "Nobody answered within a day." }
  }
}

listen to runs {} fire `Approve Or Reject`
```

Slack carries buttons from this release. Telegram and WhatsApp do not report taps as `Interactions` yet: send a form's link there instead (next).

### A link a person opens: a callback's `url`

Before, the run handed out a callback's `url`, and a value the person supplied arrived as the callback's parameter.

```
booked = callback((day: <date>) => { … })
write ops-[:Messages]-> { Message: "Pick a day: ${booked.url}" }
```

After, the link is a form from `@lf/forms`. Its fields are a `node` you declare, and the answer arrives on the form's `Submissions`, typed by that node.

```
import { `@lf/slack` as slack, `@lf/forms` as forms_module, `@lf/manual` as manual } from adapters
import { team_workspace } from credentials

team  = connect slack using team_workspace
forms = connect forms_module
runs  = connect manual

node Booking {
  Day: <date>
}

function `Book A Day`(go: <runs-[:Invocation]->>) {
  ops = only(team-[ch:Channels WHERE ch.Name == "ops"]->)
  if (ops == null) { fail("no #ops channel") }
  form = write forms-[:Forms]-> { Title: "Pick a day for ${go.Text}", Fields: Booking }
  write ops-[:Messages]-> { Message: "Pick a day: ${form.Url}" }

  r = race(
    () => {
      booking = await form-[:Submissions]->
      return booking.Day
    },
    () => { await sleep(2d) },
  )

  if (r[0] != null) {
    write ops-[:Messages]-> { Message: "Booked for ${r[0]}." }
  }
}

listen to runs {} fire `Book A Day`
```

- `listen-fire serve` serves the form at the project's public address (`publicUrl` in `lf.yaml`). It takes no credential.
- A form takes one answer; a different second one is turned away.

### `ttl` and `once: false`

- **`ttl`** is the program's `race` with a `sleep`, as in both programs above. A form never expires on its own.
- **`once: false`** (many answers in one run) becomes a standing `listen` on the message's `Interactions`, one run per answer, keeping its state in a table.

### What the callback's body did

The body ran when the person acted. Write it after the wait instead, in the arm that waited: it sees everything the run holds, as the body did.

## 4. A wait's `WHERE` keeps the values it read from the run

- A wait's `WHERE` that reads a field of a record the run holds (`founder.Email` in `await m-[x:Replies WHERE x.From == founder.Email]->`) now reads it once, when the wait is reached, and keeps that value while the run waits.
- Under 0.12 it was read again at every check, so a change to that record while the run waited changed which reply counted.
- What the `WHERE` reads from a system, such as a walk off a connection, is still read at every check.
- `listen-fire upgrade` lists each such wait as a warning (`MOV_AWAIT_VALUE_CAPTURED`), naming the fields. There is nothing to rewrite, and the pin still moves.
- A wait that must follow the live value tests it after the wait, against the record re-read with `refresh`.
- Why: a wait keeps the values it was written with, as a closure keeps what it closed over.

## 5. What a wait binds is always there

- When the record a wait hangs off is deleted, the wait settles empty: the code after the `await` in its scope runs zero times, and the scope around it goes on. In a `race`, that arm drops out and the race goes on with the others.
- So what `await` binds is typed present. A guard after it can never run: delete it.

| Before | After |
| --- | --- |
| `reply = await first(msg-[:Replies]->)` then `if (reply == null) { fail("no reply") }` | `reply = await msg-[:Replies]->` and nothing more |

Nothing refuses the old guard; it is dead code.

## 6. Runs parked under 0.12

A run parked under 0.12 cannot resume on a 0.13 engine: it is refused on resume with "this run parked under listen-fire 0.12 (park state 2); a 0.13 engine resumes park state 3". Let parked runs finish, or cancel them (`listen-fire cancel`), before upgrading `listen-fire`. A link a 0.12 callback minted is gone for good: `/api/cb/<id>` answers 410.

## 7. Modules: `listenable` replaces `awaitable` and `watchable`

For module authors only.

- An edge declares `listenable: true` when the module announces what arrives on it, in place of `awaitable` and `watchable`. `readable` still says whether it can be listed.
- A module that still declares either retired key is refused when `listen-fire` describes it, naming `listenable`.
- A module reports what arrived as arrivals (adapter protocol 2.5), and answers `awaitKeys`. `resolveAwait` and `wakeKeys` are no longer called.
- [The adapter protocol](../contracts/adapter-protocol.md#waiting-on-your-system-awaits) ("Waiting on your system") has the contract.

## 8. Diagnostic code index

| Code | Severity under 0.13 | Section |
| --- | --- | --- |
| `MOV_V5_SPELLING` (on `await first(…)`) | error, safe fix | [2](#2-await-firstx-is-written-await-x) |
| `MOV_CALLBACK_RETIRED` | error, by hand | [3](#3-callback-is-retired) |
| `MOV_AWAIT_VALUE_CAPTURED` | warning on an upgrade from 0.12 | [4](#4-a-waits-where-keeps-the-values-it-read-from-the-run) |
| `MOV_AWAIT_UNORDERED` | error, by hand: write `await new` on an edge with no declared order | [2](#2-await-firstx-is-written-await-x) |
| `MOV_AWAIT_BARE_WALK` | error, by hand: bind the record the last edge leaves from, then await that edge | [2](#2-await-firstx-is-written-await-x) |
