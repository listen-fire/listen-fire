# Migrating to 0.13

0.13.0 opens a new compatibility key: it reads pins of `0.13.x` only. A project pinned to `0.12.x` is refused by name until it is upgraded, and `listen-fire upgrade` moves its pin once every file checks clean. The [changelog entry](../../CHANGELOG.md) lists each change in a line; this guide shows each one with a program you can run.

One idea runs through the release: **what happens outside arrives on an edge.** A press arrives on a message's `Interactions`, a form's answer on its `Submissions`, a reply on a thread's `Replies`, a tick on the clock's `Ticks`. A run waits for one by traversing that edge with `await`, and a listen starts a run on each by traversing it with `listen to`, as either reads any other edge. The handbook's reviews and listeners chapters teach the forms below in full.

## Contents

- [1. How the pin moves](#1-how-the-pin-moves)
- [2. `await first(x)` is written `await x`](#2-await-firstx-is-written-await-x)
- [3. `callback(…)` is retired](#3-callback-is-retired)
- [4. A wait's `WHERE` keeps the values it read from the run](#4-a-waits-where-keeps-the-values-it-read-from-the-run)
- [5. What a wait binds is always there](#5-what-a-wait-binds-is-always-there)
- [6. Runs parked under 0.12](#6-runs-parked-under-012)
- [7. Modules: `listenable` replaces `awaitable` and `watchable`](#7-modules-listenable-replaces-awaitable-and-watchable)
- [8. Listens are traversals](#8-listens-are-traversals)
- [9. A field is never read through a value that may be missing](#9-a-field-is-never-read-through-a-value-that-may-be-missing)
- [10. Diagnostic code index](#10-diagnostic-code-index)

## 1. How the pin moves

- `listen-fire upgrade` checks every movement file of the project as a move up from its pin, and applies the fixes marked safe. `--check` prints the diff and writes nothing; `--all` also applies the fixes that may change meaning.
- The pin (`engine:` in `lf.yaml`) moves to `0.13.0` only when every file then checks clean and no warning stands. Otherwise it stays, and the command lists what is left to change by hand.
- A change of meaning with nothing to rewrite is a warning: a wait's captured values (section 4), a wait no `sleep` races (section 5), a read of a field whose meaning changed (section 8).
  - `listen-fire upgrade` lists each one and applies the rewrites it can.
  - It leaves the pin where it was and exits 1, because moving the pin puts the program live under the new meaning.
  - Check each read, then run `listen-fire upgrade --all`, which moves the pin past the warnings.
- Until the pin moves, a 0.13 `listen-fire` refuses the project by name: "this automation pins language 0.12.13, which this release (0.13.0) does not read; validate it under 0.13.0 and upgrade it".

The order that works:

1. Run `listen-fire upgrade --check` and read what it lists.
2. Replace each `callback(…)` by hand (section 3).
3. Run `listen-fire upgrade`. It respells `await first(…)` (section 2) and each listen it can (section 8), lists the warnings (sections 4, 5 and 8), and moves the pin when none is left. If it lists a wait or a listen it cannot rewrite, rewrite it by hand (sections 2, 8 and 9) and run it again.
4. Run `listen-fire upgrade --all` only once you have read what its remaining fixes change (section 8) and checked each warning: it applies those fixes and moves the pin past the warnings.
5. Delete the `== null` guards after waits (section 5).

## 2. `await first(x)` is written `await x`

A wait pulls exactly one record off one edge, so the bare traversal says it.

| Before | After |
| --- | --- |
| `reply = await first(msg-[:Replies]->)` | `reply = await msg-[:Replies]->` |

- `MOV_V5_SPELLING` carries the rewrite as a safe fix, and `listen-fire upgrade` applies it. It waits for the same one record.
- New in 0.13: `await new msg-[:Replies]->` takes only a reply that arrives after `msg` entered the run, skipping any already in the thread.
  - A run's trigger, and each record its arrival carries (an Attio change carries its deal), entered the run at its delivery. The arrival that started the run never answers it.
  - A record the run steps to that its arrival did not carry (the deal's company) entered at that step.

Two waits 0.12 accepted are refused once respelled, and the pin holds until each is rewritten by hand:

- **An edge that can be listed but declares no order** (`MOV_AWAIT_UNORDERED`). A plain `await` takes the first match already there, and with no order there is no first. Write `await new`, which waits only for what arrives.
- **A wait at the end of a walk of more than one edge** (`MOV_AWAIT_BARE_WALK`). Bind the record the last edge leaves from, then await that edge off it.

| Before | After |
| --- | --- |
| `c = await first(deal-[:Comments]->)`, where `Comments` declares no order | `c = await new deal-[:Comments]->` |
| `reply = await first(ops-[:Messages]->-[:Replies]->)` | `msg = only(ops-[:Messages]->)`, then `if (msg == null) { fail("no message") }`, then `reply = await msg-[:Replies]->` |

```
team = connect `@lf/slack` using team_workspace

function `Who Takes It`(go: <manual-[:Invocation]->>) {
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

listen to manual-[:Invocations]-> fire `Who Takes It`
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
team = connect `@lf/slack` using team_workspace

function `Approve Or Reject`(go: <manual-[:Invocation]->>) {
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

listen to manual-[:Invocations]-> fire `Approve Or Reject`
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
team  = connect `@lf/slack` using team_workspace
forms = connect `@lf/forms`

node Booking {
  Day: <date>
}

function `Book A Day`(go: <manual-[:Invocation]->>) {
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

listen to manual-[:Invocations]-> fire `Book A Day`
```

- `listen-fire serve` serves the form at the project's public address (`publicUrl` in `lf.yaml`). It takes no credential.
- A form takes one answer; a different second one is turned away.

### `ttl` and `once: false`

- **`ttl`** is the program's `race` with a `sleep`, as in both programs above. A form never expires on its own.
- **`once: false`** (many answers in one run) becomes a standing listen on the presses, one run per answer, keeping its state in a table: [the lunch poll](#many-answers-the-lunch-poll) in section 8.

### What the callback's body did

The body ran when the person acted. Write it after the wait instead, in the arm that waited: it sees everything the run holds, as the body did.

## 4. A wait's `WHERE` keeps the values it read from the run

- A wait's `WHERE` that reads a field of a record the run holds (`founder.Email` in `await m-[x:Replies WHERE x.From == founder.Email]->`) now reads it once, when the wait is reached, and keeps that value while the run waits.
- Under 0.12 it was read again at every check, so a change to that record while the run waited changed which reply counted.
- What the `WHERE` reads from a system, such as a walk off a connection, is still read at every check.
- `listen-fire upgrade` lists each such wait as a warning (`MOV_AWAIT_VALUE_CAPTURED`), naming the fields. There is nothing to rewrite, and the pin stays until you have checked the wait and run `listen-fire upgrade --all`.
- A wait that must follow the live value tests it after the wait, against the record re-read with `refresh`.
- Why: a wait keeps the values it was written with, as a closure keeps what it closed over.

## 5. What a wait binds is always there

- When the record a wait hangs off is deleted, the wait keeps waiting: the code after the `await` never runs, and the run stays parked. Many systems cannot say a record went, so no module is relied on to.
- So race every wait on a person or a system with a `sleep`: `race(() => { return await msg-[:Replies]-> }, () => { await sleep(2d) })`. A deleted record's arm never settles, and the `sleep` takes the race.
- `listen-fire runs` lists a run parked on a deleted record as `parked (stranded)`. A program hears of it on `@lf/system`: `listen to sys-[e:Events WHERE e.Kind == "Wait Lost Its Record"]-> fire f`.
- `listen-fire upgrade` lists each `await` no `sleep` races as a warning (`MOV_AWAIT_MAY_HANG`), showing the race to write. A wait inside a function is listed once, at the unraced call that reaches it, with the calls down to the wait: race the call, and the wait inside is raced. The pin stays until you have raced the wait or decided it can wait forever, and run `listen-fire upgrade --all`.
- What `await` binds is typed present. A guard after it can never run: delete it.

| Before | After |
| --- | --- |
| `reply = await first(msg-[:Replies]->)` then `if (reply == null) { fail("no reply") }` | `reply = await msg-[:Replies]->` and nothing more |

Nothing refuses the old guard; it is dead code.

The record a wait hangs off must be there when the wait is reached. A wait off a name that may hold no record (`d = only(c-[:Deals]->)`, then `await new d-[:Notes]->`) is refused (`MOV_ABSENT_REQUIRED`), as a block's walk off one is: under 0.12 it checked clean and failed the run at the wait. Guard it: `if (d != null) { n = await new d-[:Notes]-> }`, or end the run first when it is missing (`if (d == null) { fail("no deal") }`).

## 6. Runs parked under 0.12

A run parked under 0.12 cannot resume on a 0.13 engine: it is refused on resume with "this run parked under listen-fire 0.12 (park state 2); a 0.13 engine resumes park state 3". Let parked runs finish, or cancel them (`listen-fire cancel`), before upgrading `listen-fire`. A link a 0.12 callback minted is gone for good: `/api/cb/<id>` answers 410.

## 7. Modules: `listenable` replaces `awaitable` and `watchable`

For module authors only.

- An edge declares `listenable: true` when the module announces what arrives on it, in place of `awaitable` and `watchable`. `readable` still says whether it can be listed.
- A module that still declares either retired key is refused when `listen-fire` describes it, naming `listenable`.
- A module reports what arrived as arrivals (adapter protocol 2.5), and answers `awaitKeys`. `resolveAwait` and `wakeKeys` are no longer called.
- [The adapter protocol](../contracts/adapter-protocol.md#waiting-on-your-system-awaits) ("Waiting on your system") has the contract.
- A listenable edge also declares how its arrivals come (adapter protocol 2.6): pushed or polled (`pollEverySeconds`), what bounds it, which earlier hops an arrival carries, and how often a hop is listed again. The manifest's listen vocabulary (`subscribableEvents`, `listenConfig`, an entry point's `fires`) is refused when `listen-fire` describes the module. A module may declare `listenSettingsBecome`, which `listen-fire upgrade` reads to rewrite its 0.12 listens (section 8).
- [Declaring a listenable edge](../contracts/adapter-protocol.md#declaring-a-listenable-edge) has the contract, and [what lf-platform adopts](../contracts/platform-adoption-0.13.md) lists every host and store change.

## 8. Listens are traversals

- A listen is a traversal from a connection that ends on an edge its module declares listenable: `listen to gh-[n:Notifications WHERE n.Reason == "mention"]-> fire triage`. The settings form, `listen to gh { events: ["mention"] } fire triage`, is refused under every pin (`MOV_LISTEN_SETTINGS_RETIRED`).
- The fired function's parameter is typed by what lands, addressed from the connection: the edge (`<gh-[:Notifications]->>`) or its record type (`<pay-[:InvoiceChange]->>`). `listen-fire upgrade` retypes it with the listen.
- Why: a listen says which records it wants as a read or a wait does, so it is checked as they are, a filter is judged one way on every host, and listens on one edge share one poll or webhook. The settings form was a second vocabulary per module, unchecked against what arrives.
- The handbook's listeners chapter teaches the form in full: where each filter is judged, unbounded edges, loops, and an arrival a listen could not judge.
- A listen that could never fire is refused where it is written, never checked clean:
  - a filter judged on each arrival that reads an earlier hop the arrival does not carry (`MOV_LISTEN_UNWATCHABLE`): the judge has only what arrives;
  - a window measured from now (`WITHIN`) on a hop the host lists to find what to watch (`MOV_LISTEN_UNWATCHABLE`): that hop is judged again only when it is listed again, so put the window on what arrives.

### One name for one hop

One walk names each hop once: `-[c:Channels]->-[c:Messages]->` is refused (`MOV_HOP_ALIAS_REPEATED`), on a listen, a block or a walk inside an expression. Under 0.12 a later read of `c` meant the nearest hop to the checker and the first to a listen's judge. Give each hop its own alias.

A later hop's `WHERE` or `ORDER BY` may read an earlier hop of the same walk, in a run as on a listen: `at-[t:Tables]->-[c:History WHERE c.Id == t.Name]->` filters each Table's History by that Table's own Name. Under 0.12 it checked clean and failed the run.

### What the upgrade rewrites

`MOV_LISTEN_SETTINGS_RETIRED` carries the rewrite where the module declares how its settings map. There are three outcomes:

- **A safe fix**, applied by `listen-fire upgrade`: the traversal hears what the settings heard. A key the listen left out is compared with what leaving it out meant (an inbox listen with no key heard the box's own mail: `e.Key == ""`).
- **A fix only `listen-fire upgrade --all` applies**, because the listen then hears something else. The diagnostic says what changes:
  - `suppress_self: true` is deleted. The host breaks every loop itself (below), so a two-way sync's echo runs once more and then stops.
  - `every` is deleted. The module sets how often its edge is polled; set `pollEvery` in `lf.yaml` for the connection (below).
  - Several values for a field the module cannot match any of (`containsAny` undeclared) are an `OR` the host compares one by one.
  - An Airtable `field` naming an attachment field compares the files by identity.
- **No fix**: the pin holds, and the diagnostic names the traversal to write by hand.
  - A listen whose events arrive on two edges (a message and a reaction, two Stripe objects): write one listen per edge.
  - A listen that named no events on such a module, which heard them all.
  - A value the field refuses (an email key no address can carry), or a field the table lacks.
  - An Attio listen: its objects are each workspace's own.

### Each module's listen

Each entry shows a 0.12 listen, the 0.13 listen `listen-fire upgrade` writes for it, and the fired function's parameter. "By hand" marks a listen with no rewrite.

#### `cron`

- 0.12: `listen to cron { schedule: "0 9 * * 1-5", timezone: "Europe/London" } fire digest`
- 0.13: `listen to cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1-5" AND t.Zone == "Europe/London"]-> fire digest`, parameter `<cron-[:Ticks]->>`
- `Ticks` is unbounded: a listen names its schedules (`==` or `IN`). One naming no zone ticks in UTC.
- A tick fires on time: each poll of the clock says when its next tick is due, and the host polls then (adapter protocol 2.7). A host before 2.7 polls every minute, so a tick there fires up to a minute late. Each poll fires every occurrence since the last; after downtime only the latest missed one fires.

#### `manual`

- 0.12: `listen to manual fire hello`
- 0.13: `listen to manual-[:Invocations]-> fire hello`, parameter `<manual-[:Invocations]->>`

#### `@lf/email`

- 0.12: `listen to inbox { key: "Deals" } fire intake`
- 0.13: `listen to inbox-[e:Emails WHERE e.Key == "deals"]-> fire intake`, parameter `<inbox-[:Emails]->>`
- 0.12: `listen to inbox {} fire intake`
- 0.13: `listen to inbox-[e:Emails WHERE e.Key == ""]-> fire intake`, parameter `<inbox-[:Emails]->>`
- `Key` is the plus-suffix the mail was sent to, lowercased; mail to the box itself has the empty key. `Emails` is unbounded, so a listen names its keys.

#### `@lf/webhook`

- 0.12: `listen to hooks { payload: <Payment> } fire paid`
- 0.13: `listen to hooks-[:Requests]-><Payment> fire paid`, parameter `<Payment>`
- A delivery's body is untyped JSON, and the listen states the node it is after the traversal. A delivery that fits no listen's node is answered 400, naming the fields.

#### `@lf/github`

- 0.12: `listen to gh { events: ["mention", "assign"], participating: true } fire triage`
- 0.13: `listen to gh-[n:Notifications WHERE n.Reason IN ["mention", "assign"] AND n.Participating == true]-> fire triage`, parameter `<gh-[:Notifications]->>`
- `participating: false` heard every thread, so it becomes no comparison.

#### `@lf/gmail`

- 0.12: `listen to mail { query: "from:acme", labels: ["INBOX"] } fire triage`
- 0.13: `listen to mail-[m:Messages WHERE m.Query == "from:acme" AND m.Labels CONTAINS "INBOX"]-> fire triage`, parameter `<mail-[:Messages]->>`
- 0.12: `listen to mail { events: ["label_added"], labels: ["Deals"] } fire filed`
- 0.13: `listen to mail-[l:Labelings WHERE l.Label IN ["Deals"]]-> fire filed`, parameter `<mail-[:Labelings]->>`
- A label added to a message already there is its own arrival, on `Labelings`. Labels are compared by name (`Deals`), never by id.
- A label removed and added again fires again, where 0.12 fired once, so `listen-fire upgrade` applies this rewrite only under `--all`.
- `Labels` holds label names where it held ids: a 0.12 program that reads it is warned where it does (`MOV_FIELD_MEANING_CHANGED`), and the pin stays until you have checked each read and run `listen-fire upgrade --all`.
  - A comparison with Gmail's own labels (`INBOX`, `UNREAD`, …) is not warned: they are spelled as before.
  - A 0.12 listen on a custom label's id (`labels: ["Label_12"]`) is rewritten to compare that id with names, so it would never fire: write the label's name (`Deals`) before moving the pin.

#### `@lf/granola`

- 0.12: `listen to notes { folder: "Deals" } fire summarise`
- 0.13: `listen to notes-[n:Meetings WHERE n.Folders CONTAINS "deals"]-> fire summarise`, parameter `<notes-[:Meetings]->>`

#### `@lf/dealroom`

- 0.12: `listen to rounds { rounds: ["SERIES A"], hq_locations: ["Germany"] } fire triage`
- 0.13: ``listen to rounds-[r:`Funding Rounds` WHERE r.Round IN ["SERIES A"] AND r.`Company Locations` CONTAINS "Germany"]-> fire triage``, parameter ``<rounds-[:`Funding Rounds`]->>``

#### `@lf/evertrace`

- 0.12: `listen to signals { search: "Stealth in Europe" } fire triage`
- 0.13: ``listen to signals-[s:Signals WHERE s.`Saved Search` == "Stealth in Europe"]-> fire triage``, parameter `<signals-[:Signals]->>`
- 0.12: `listen to signals { events: ["list_entry"], list: "Pipeline" } fire triage`
- 0.13: ``listen to signals-[e:`List Entries` WHERE e.`List Name` == "Pipeline"]-> fire triage``, parameter ``<signals-[:`List Entries`]->>``

#### `@lf/stripe`

- 0.12: `listen to pay { events: ["invoice.payment_failed"] } fire failed`
- 0.13: `listen to pay-[:Invoices]->-[c:Changes WHERE c.Kind IN ["payment_failed"]]-> fire failed`, parameter `<pay-[:InvoiceChange]->>`
- Each object's events arrive on its own `Changes` (`InvoiceChange`, `SubscriptionChange`, `CustomerChange`, `ChargeChange`), and `Kind` is the event type without the object's prefix. A listen naming two objects' events, or none, is rewritten by hand: one listen per object.

#### `@lf/attio`

- 0.12: `listen to crm { events: ["record.updated"] } fire moved`
- 0.13, by hand: `listen to crm-[:Deals]->-[c:Changes WHERE c.Field == "Stage"]-> fire moved`, parameter `<crm-[:DealChange]->>`
- Each object's records have their own `Changes`. On an update, `Field` is the attribute that changed. Walk the change's `Deal` for the record.

#### `@lf/affinity`

- 0.12: `listen to crm { events: ["organization.created", "organization.updated"] } fire welcomed`
- 0.13, under `listen-fire upgrade --all`: `listen to crm-[:Organization]->-[c:Changes WHERE c.Kind IN ["created", "updated"]]-> fire welcomed`, parameter `<crm-[:OrganizationChange]->>`
- `Kind == "updated"` also hears each field value set or cleared on the organization, which 0.12 heard only as `field_value` events. Add `AND c.Field == null` to hear the organization's own changes alone. The same holds for a person and an opportunity.
- A list entry's changes are written by hand, from the list: ``listen to crm-[:`List Entry — Master Deals List`]->-[c:Changes WHERE c.Field == "Status"]-> fire moved``, parameter ``<crm-[:`List Entry Change — Master Deals List`]->>``.
- A listen naming a note's or a reminder's events has no rewrite: they run nothing in 0.13.

#### `@lf/telegram` and `@lf/whatsapp`

- 0.12: `listen to tg {} fire heard`
- 0.13: `listen to tg-[:Messages]-> fire heard`, parameter `<tg-[:Messages]->>`
- 0.12: `listen to wa { events: ["reaction"] } fire reacted`
- 0.13: `listen to wa-[:Reactions]-> fire reacted`, parameter `<wa-[:Reactions]->>`
- Neither system can list its chats, so `Messages` (and WhatsApp's `Reactions` and `Locations`) start at the connection. Narrow to one chat on the record itself: ``m.`Chat Id` == "42"`` on Telegram, `m.From == "447700900001"` on WhatsApp.

#### `@lf/airtable`

- 0.12: `listen to hiring { base: "appHIRE01", table: "tblCAND01", field: "Stage", becomes: "Interview" } fire staged`
- 0.13: `listen to hiring-[t:Tables WHERE t.Id == "tblCAND01"]->-[c:Changes WHERE exists(c.Current) AND c.Current.Stage == "Interview" AND (NOT exists(c.Previous) OR c.Previous.Stage != "Interview")]-> fire staged`, parameter ``<hiring-[:`Candidates Change`]->>``
- A change is one per row an edit touched, with `Kind` (`created`, `updated`, `deleted`), `Current` (the row as the edit left it) and `Previous` (as it was). Each is a record read with `.`, and absent where there is no row, so the rewrite tests it first (section 9).
- The rewrite narrows to the table by its id, and the parameter to that table's change type, whose rows have the table's fields. Narrowing by name (`t.Name == "Candidates"`) follows a rename in Airtable.
- `field` alone becomes a comparison of `Current` with `Previous`; `events` becomes `c.Kind IN [...]`. A connection not positioned at a base starts at its `Bases`: `at-[b:Bases WHERE b.Name == "Hiring"]->-[t:Tables …]->`.
- A function's reads of the 0.12 change are rewritten by hand (from listen-fire 0.13.1):
  - ``change.`Changed Fields` `` stays ``c.`Changed Fields` ``.
  - `change.base`, `change.table` and `change.record` become ``c.`Base Id` ``, ``c.`Table Id` `` and ``c.`Record Id` ``.
  - `change-[:Record]->`, the row as the edit left it, becomes `c.Current`, and `` change-[:`Old Record`]-> `` becomes `c.Previous`, each tested present first. `c-[:Record]->` is the row as it is now, read from Airtable.

#### `@lf/slack`

- 0.12: `listen to chat { events: ["message"], channels: ["deals"] } fire triage`
- 0.13, by hand: `listen to chat-[ch:Channels WHERE ch.Name IN ["deals"]]->-[:Messages]-> fire triage`, parameter `<chat-[:Message]->>`
- 0.13, by hand, for a thread's replies: `listen to chat-[:Channels]->-[:Messages]->-[m:Replies WHERE m.Channel == "C0DEALS"]-> fire triage`, parameter `<chat-[:Message]->>`
- 0.12: `listen to chat { events: ["app_mention"] } fire answer`
- 0.13, by hand: ``listen to chat-[:Channels]->-[m:Messages WHERE m.`Mentions App` == true]-> fire answer``, parameter `<chat-[:Message]->>`
- 0.13, by hand, for a thread's replies: ``listen to chat-[:Channels]->-[:Messages]->-[m:Replies WHERE m.`Mentions App` == true]-> fire answer``, parameter `<chat-[:Message]->>`
- A reply arrives on its thread's `Replies`, not on `Messages`, so no one listen hears what `message` and `app_mention` heard: `listen-fire upgrade` writes no rewrite for them and says to write one listen for each edge. A reply carries no channel record, so its listen narrows by the reply's own `Channel`, the channel's id.
- 0.12: `listen to chat { events: ["reaction_added"] } fire noted`
- 0.13: `listen to chat-[:Channels]->-[:Messages]->-[:Reactions]-> fire noted`, parameter `<chat-[:Reaction]->>`
- A message and a reaction carry their channel, and a press carries its channel and the message pressed, so a filter on those hops is judged on the arrival. A listen naming no events heard messages and reactions: write one listen for each.
- A message written with `Buttons` may carry a `Topic`, which a press carries back: [the lunch poll](#many-answers-the-lunch-poll) below listens on it.

#### `@lf/system`

- 0.12: `listen to sys {} fire report`
- 0.13: `listen to sys-[e:Events WHERE e.Kind == "Run Failed"]-> fire report`, parameter `<sys-[:Events]->>`
- 0.12: `listen to sys { events: ["Run Failed", "Wait Lost Its Record"] } fire report`
- 0.13: `listen to sys-[e:Events WHERE e.Kind IN ["Run Failed", "Wait Lost Its Record"]]-> fire report`, parameter `<sys-[:Events]->>`
- One `Events` edge carries every kind. listen-fire reports `Run Failed`, `Wait Lost Its Record` (a wait whose record was deleted), `Arrival Not Judged` (a listen that could not tell whether an arrival fires it) and `Release Applied`.

### `suppress_self` is gone

- 0.12's `suppress_self: true` kept a listen from hearing its own run's writes. 0.13 drops it: the host breaks every loop, whether the listen asked or not.
- An arrival on a record a run wrote at most `loopWindow` before continues that run's chain. The listen whose arrival would make a chain longer than `loopDepth` runs is paused (`LISTEN_LOOP`), naming the chain.
- While it is paused, its arrivals are counted and not run (`listen-fire listens` shows the count). `listen-fire listens resume <file>:<movement>` lets it fire again; what it held is not run.
- A write that would change nothing is never sent where the module reads the record back, so a two-way sync's echo writes nothing and its chain ends there.

### What `lf.yaml` sets

A listen sets no numbers. Each comes from the module's declaration, and `lf.yaml` overrides it:

| Key | What it sets | Default |
| --- | --- | --- |
| `pollEvery: { <credential>: 5m }` | how often a connection's polled edges are polled (a connection with no credential is named by its module) | the edge's `pollEverySeconds` |
| `resolveEvery: { <credential>: 1h }` | how often a listen's filtered earlier hops are listed again | the hop's `membersChange: { relistEverySeconds }` |
| `resendWindow: { <module>: 3d }` | how long a provider's re-send of an arrival is the same arrival | the module's (Stripe: 3 days) |
| `loopWindow: 20s` | how soon after a run's write an arrival on that record continues its chain | `20s` |
| `loopDepth: 10` | how many runs one chain may be before its listen is paused | `10` |
| `listenScopeLimit: 500` | how many records a listen's earlier hops may match before it is suspended | `500` |
| `deliveries: { retainDays: 14 }` | how long a delivery's request is kept, for `listen-fire listens replay` | `14` |

### Many answers: the lunch poll

`callback(…, { once: false })` took many answers in one run. In 0.13 each answer is its own run of a standing listen, and the state lives in a table. The poll is a Slack message with `Buttons` and a `Topic`, and every press on a message with that `Topic` runs `count_vote`, one row per poll and person:

```
chat = connect `@lf/slack` using team_slack
office = connect `@lf/airtable` using team_airtable { base: "Office" }

function ask_lunch(t: <cron-[:Ticks]->>) {
  channel = only(chat-[ch:Channels WHERE ch.Name == "office"]->)
  if (channel == null) { fail("no #office channel") }
  write channel-[:Messages]-> {
    Message: "Lunch on Friday?"
    Topic: "lunch-poll"
    Buttons: [{ Text: "In", Value: "in" }, { Text: "Out", Value: "out" }]
  }
}

function count_vote(press: <chat-[:Interaction]->>) {
  poll = only(press-[:Message]->)
  if (poll == null) { fail("a press with no message") }
  answer = only(press-[:Actions]->).Value
  if (answer == null) { fail("a press with no answer") }
  person = only(press-[:By]->)
  if (person == null) { fail("a press by no one") }
  write office-[:Lunch]-> {
    unique by (Poll, `Person Id`)
    Poll: poll.Id
    `Person Id`: person.Id
    Person: person.Name
    Answer: answer
  }
}

listen to cron-[t:Ticks WHERE t.Schedule == "0 10 * * 3" AND t.Zone == "Europe/London"]-> fire ask_lunch
listen to chat-[:Channels]->-[m:Messages WHERE m.Topic == "lunch-poll" AND m.Timestamp WITHIN 3d]->-[:Interactions]-> fire count_vote
```

- The listen's filters are judged on the press itself: a press carries the message it was on, and with it the message's `Topic` and `Timestamp`.
- A second press by the same person updates their row (``unique by (Poll, `Person Id`)``).
- `m.Timestamp WITHIN 3d` stops counting presses on polls older than three days.

## 9. A field is never read through a value that may be missing

- A field read through a value that may be missing is refused (`MOV_ABSENT_REQUIRED`), as TypeScript's strict null checks refuse `x.F` where `x` may be undefined. Such a value is a record a change holds (Airtable's `c.Previous` is missing on a created row), a name bound to one, or a map member that may be missing.
- Under 0.12 the read answered missing and checked clean, so `c.Previous.Stage != "Interview"` passed on a created row unseen.
- Test the value first with `exists`, and the read after it is allowed:
  - `exists(c.Previous) AND c.Previous.Stage == "Applied"`;
  - `NOT exists(c.Previous) OR c.Previous.Stage != "Interview"`;
  - `if (exists(c.Previous)) { … }` in a function, and `&&`, `||` and `!` there.
- `listen-fire upgrade` writes the tested forms in the listens it rewrites. Anything else is by hand, and holds the pin.
- Not yet refused in 0.13: a field read off a graph record that may be missing (`x = only(…)`, then `x.Name`) still reads missing. A later release refuses it, with `?.`.

## 10. Diagnostic code index

| Code | Severity under 0.13 | Section |
| --- | --- | --- |
| `MOV_V5_SPELLING` (on `await first(…)`) | error, safe fix | [2](#2-await-firstx-is-written-await-x) |
| `MOV_CALLBACK_RETIRED` | error, by hand | [3](#3-callback-is-retired) |
| `MOV_AWAIT_VALUE_CAPTURED` | warning on an upgrade from 0.12, holds the pin until `--all` | [4](#4-a-waits-where-keeps-the-values-it-read-from-the-run) |
| `MOV_AWAIT_UNORDERED` | error, by hand: write `await new` on an edge with no declared order | [2](#2-await-firstx-is-written-await-x) |
| `MOV_AWAIT_BARE_WALK` | error, by hand: bind the record the last edge leaves from, then await that edge | [2](#2-await-firstx-is-written-await-x) |
| `MOV_AWAIT_MAY_HANG` | warning on an upgrade from 0.12, holds the pin until `--all`: race the wait with a `sleep` | [5](#5-what-a-wait-binds-is-always-there) |
| `MOV_LISTEN_SETTINGS_RETIRED` | error: a safe fix, a fix `--all` applies, or by hand | [8](#8-listens-are-traversals) |
| `MOV_ABSENT_REQUIRED` (a field read through a value that may be missing) | error, by hand: test the value with `exists` | [9](#9-a-field-is-never-read-through-a-value-that-may-be-missing) |
| `MOV_FIELD_MEANING_CHANGED` | warning on an upgrade from 0.12, holds the pin until `--all`: the field holds something else now (gmail's `Labels`: names, not ids) | [8](#8-listens-are-traversals) |
| `MOV_ABSENT_REQUIRED` (a wait off a record that may be missing) | error, by hand: guard the wait with `!= null` | [5](#5-what-a-wait-binds-is-always-there) |
| `MOV_LISTEN_EDGE_NOT_LISTENABLE`, `MOV_LISTEN_HOP_NOT_ITERABLE`, `MOV_LISTEN_UNWATCHABLE`, `MOV_LISTEN_IMPURE_WHERE` | error, by hand, on a listen written or rewritten as a traversal | [8](#8-listens-are-traversals) |
| `MOV_HOP_ALIAS_REPEATED` | error, by hand: give each hop of a walk its own alias | [8](#one-name-for-one-hop) |
| `MOV_UNBOUNDED_EDGE` | error, by hand: narrow the hop by a field its module takes, with literals (`-[t:Ticks WHERE t.Schedule == "…"]->`) | [changelog](../../CHANGELOG.md#0130) |
| `MOV_FILTER_NOT_TAKEN` | error, by hand: compare a field only its module evaluates with a literal its module takes | [changelog](../../CHANGELOG.md#0130) |
| `MOV_OWNED_VALUE_INVALID` | error, by hand: write a value its module accepts (a five-field schedule, a time zone) | [changelog](../../CHANGELOG.md#0130) |
| `MOV_COLLECTION_NOT_READABLE` | error, by hand: a collection its module only writes to or announces on is written to or listened to, never read | [changelog](../../CHANGELOG.md#0130) |
| `MOV_WALK_ROOT_NOT_RECORD`, `MOV_WALK_OFF_HELD_RECORD` | error, by hand: start a walk at a graph record (off a change's row, walk from the live record: `c-[:Record]->-[:X]->`) | [changelog](../../CHANGELOG.md#0130) |
