<!--
The micro examples: a few lines of listen-fire doing one thing each, for an
author unsure how to write it. `listen-fire example <words>` and the authoring
tools' showExample search them; the handbook's tests check every one.

Each example is a `### id` section: the intent in plain words, a `search:` line
of the words an author might ask with, one fenced snippet of at most eight lines,
and at most one sentence after it, only where the code cannot speak.

The fence's word says how the check wraps the snippet into a whole program:
- body: inside a function `m` arrives at, an email from Gmail (`m: <mail-[:Message]->>`),
  with `gh` (GitHub), `mail` (Gmail) and `chat` (Slack) connected;
- program: at the top level, with the same three connected;
- file: the whole program as shown.
A second word, `fake`, says the snippet names a system the handbook's catalog
does not carry: it is checked by `listen-fire check` against that module's fake
(apps/cli), not by the handbook's tests.

Recommended forms only. Keep the wording generic: GitHub, Gmail, Slack, the
schedule, the run's own graph, a declared node.
-->

### listen-with-a-where

Run a function when a record arrives, only for some arrivals
search: listen trigger event fire arrival webhook on new when filter where notification subscribe react

```program
function `Assigned`(n: <gh-[:Notification]->>) {
  return n.Title
}

listen to gh-[n:Notifications WHERE n.Reason == "assign"]-> fire `Assigned`
```

The function's one parameter is typed by the record the walk lands on.

### run-on-a-schedule

Run on a schedule
search: cron schedule every monday daily weekly hourly timer tick recurring periodic time of day

```program
function `Weekly`(t: <cron-[:Ticks]->>) {
  return t.`Fired at`
}

listen to cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1" AND t.Zone == "Europe/London"]-> fire `Weekly`
```

`cron` is always there and is never connected; the schedule is a five-field cron line.

### run-by-hand

Run by hand, with text or files handed in
search: manual run ad hoc invoke invocation backfill paste text button on demand test input

```program
function `Import`(i: <manual-[:Invocations]->>) {
  return Text.split(i.Text, "\n")
}

listen to manual-[:Invocations]-> fire `Import`
```

`listen-fire run Import --text "…"` fires it.

### listen-to-a-channel

Run on each new message in one chat channel
search: slack channel message listen trigger chat messages new message room arrives

```program
function `Support`(msg: <chat-[:Message]->>) {
  write msg-[:Replies]-> { Message: "On it." }
}

listen to chat-[ch:Channels WHERE ch.Name == "general"]->-[msg:Messages]-> fire `Support`
```

### run-when-a-run-fails

Run when another automation fails
search: failure failed error alert monitor watch run failed notify on error

```file
sys = connect `@lf/system`

function `Report`(e: <sys-[:Event]->>) {
  return "${e.Automation} failed: ${e.Reason}"
}

listen to sys-[e:Events WHERE e.Kind == "Run Failed"]-> fire `Report`
```

### read-what-an-arrival-is-about

Read the record an arrival is about
search: arrival event about related record subject issue pull request notification follow edge get record from event

```program
function `Assigned`(n: <gh-[:Notification]->>) {
  issue = only(n-[:Issue]->)
  if (issue == null) { fail("not about an issue") }
  return issue.Title
}
```

An arrival is a record; what it is about is one hop along its edge.

### connect-with-a-setting

Connect a system that needs a setting, such as an Airtable base
search: connect setting settings base airtable table option configure argument workspace spreadsheet rows fields

```file fake
ops = connect `@lf/airtable` using my_airtable { base: "Ops" }

function `Add Vendor`(i: <manual-[:Invocations]->>) {
  write ops-[:Vendors]-> { Vendor: i.Text }
}
```

Each table is an edge off the base, named after it; `listen-fire catalog` shows its fields once the program names the base.

### create-or-update

Create or update a record by an identity, so a repeat updates it
search: upsert create or update unique by identity idempotent duplicate dedupe repeat existing row key once insert

```file fake
ops = connect `@lf/airtable` using my_airtable { base: "Ops" }

function `Track Vendor`(i: <manual-[:Invocations]->>) {
  write ops-[:Vendors]-> { unique by (Vendor), Vendor: i.Text, Spend: 0 }
}
```

A second run with the same `Vendor` updates that row; lines of `unique by` are tried in turn.

### set-only-when-empty

Set a field only when it is empty, never overwriting
search: set if empty only once never overwrite keep existing value default first time optional field

```file fake
ops = connect `@lf/airtable` using my_airtable { base: "Ops" }

function `Track Vendor`(i: <manual-[:Invocations]->>) {
  write ops-[:Vendors]-> { unique by (Vendor), Vendor: i.Text, Spend ?: 0 }
}
```

`?:` is about the record's field, not the value: a value that may be missing needs `coalesce` first.

### write-off-a-connection

Write a new record straight off a connection, such as an email to send
search: write create send new record email gmail message root collection connection directly insert attach files attachment forward

```body
write mail-[:Messages]-> {
  To: ["ops@example.com"]
  Subject: "Seen: ${m.Subject}"
  Body: m.Body
  Files: m-[:Attachments]->.File
}
```

### write-along-an-edge

Write a record along another record's edge
search: write child related edge under attach comment label linked nested create under parent

```program
function `Triage`(n: <gh-[:Notification]->>) {
  issue = only(n-[:Issue]->)
  if (issue == null) { fail("not about an issue") }
  write issue-[:Labels]-> { Name: "triage" }
  write issue-[:Comments]-> { Body: "Looking at this." }
}
```

### post-to-a-channel

Post a message to a chat channel found by name
search: slack post message channel send chat notify announce

```body
ops = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
if (ops == null) { fail("no #general channel") }
write ops-[:Messages]-> { Message: "New mail: ${m.Subject}" }
```

### reply-to-an-email

Reply to an email in its thread
search: reply respond answer email thread gmail back

```body
write m-[:Replies]-> { Body: "Thanks, we have it." }
```

The thread, subject and recipient come from the email replied to.

### act-per-record

Act once per record a walk reaches
search: for each loop iterate every record walk block per item one repeat over issues in a repository

```program
function `Label Open`(t: <cron-[:Ticks]->>) {
  gh-[r:Repositories WHERE r.Name == "api"]->-[i:Issues WHERE i.State == "open"]-> {
    write i-[:Labels]-> { Name: "open" }
  }
}
```

There is no `for`: a block after a walk runs once per record it reaches.

### collect-from-records

Collect one value from each record a walk reaches
search: collect gather list of values fields from records map walk block return pluck names

```body
names = m-[a:Attachments]-> { return a.Name }
sizes = m-[:Attachments]->.Size
```

### filter-a-walk

Keep only the records that match, inside the walk
search: where filter condition match records query contains in and or not search find

```body
pdfs = m-[a:Attachments WHERE a.`Content Type` == "application/pdf" AND a.Size < 5000000]->
```

Inside the brackets a test reads like SQL: `AND`, `OR`, `NOT`, `CONTAINS`, `IN`.

### find-one-record

Find the one record that matches, and test it is there
search: find one lookup get single record only match by name search null check narrow guard present missing not null

```body
ops = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
if (ops == null) { fail("no #general channel") }
write ops-[:Messages]-> { Message: m.Subject }
```

After the test, `ops` is present for the rest of the block.

### read-a-table

Read every row of a table
search: read rows table list records all rows walk query airtable sheet select fetch

```file fake
ops = connect `@lf/airtable` using my_airtable { base: "Ops" }

function `Vendors`(i: <manual-[:Invocations]->>) {
  return ops-[v:Vendors WHERE v.Spend != null && v.Spend > 0]-> { return v.Vendor }
}
```

A table's rows are the records along its edge off the base; a cell left empty is absent, so test it before comparing.

### list-contains

Test whether a list holds a value
search: list contains includes member in array has value membership

```body
if (List.includes(m.Labels, "IMPORTANT")) {
  write m-[:Replies]-> { Body: "Seen." }
}
```

### order-and-limit

Take the newest few records
search: order by sort descending newest latest top limit first n few five ten recent most issues

```program
function `Recent`(t: <cron-[:Ticks]->>) {
  return gh-[r:Repositories WHERE r.Name == "api"]->-[i:Issues ORDER BY i.`Created At` DESC LIMIT 5]-> { return i.Title }
}
```

### sort-before-a-fold

Sort before joining, reducing or taking the first
search: sort order before join reduce first last fold ordered list set unordered text join concatenate lines

```body
names = m-[a:Attachments]-> { return a.Name }
line  = Text.join(sort(names), ", ")
top   = first(sort(names))
```

A walk answers a set, in no order, so `Text.join`, `reduce` and `first` need `sort` or `ORDER BY` first.

### count-records

Count records, or test whether there are any
search: count how many number of total records length size tally exists any has none empty whether there are some at least one

```body
n    = count(m-[:Attachments]->)
pdfs = exists(m-[a:Attachments WHERE a.Name CONTAINS ".pdf"]->)
```

### group-and-count

Group values by a key and list each group with its count
search: group by count per key groupby tally breakdown one line per summary bucket categorise

```body
authors = gh-[r:Repositories WHERE r.Name == "api"]->-[i:Issues WHERE i.State == "open"]-> { return i.Author }
by      = List.groupBy(authors, (a) => a)
lines   = map(sort(Dict.keys(by)), (a) => "${a}: ${count(by[a])}")
```

A dict's keys come in no order, so sort them before joining or taking the first.

### dict-keys

List a dict's keys, values or entries
search: dict dictionary keys values entries iterate list object map pairs

```body
by    = List.groupBy(m-[:Attachments]->, (a) => a.`Content Type`)
kinds = sort(Dict.keys(by))
lines = map(Dict.entries(by), (e) => "${e.key}: ${count(e.value)}")
```

### remove-repeats

Remove repeats from a list
search: distinct unique dedupe deduplicate duplicates repeats remove once each set

```body
authors = gh-[r:Repositories WHERE r.Name == "api"]->-[i:Issues]-> { return i.Author }
names   = List.distinct(authors)
```

Each value is kept where it first appears.

### keep-records-for-this-run

Keep records in the run's own graph, for this run only
search: graph in memory scratch temporary table run own graph node declare store collect records later walk

```program
node Seen {
  node senders { address: <text> }
}
function `Note`(m: <mail-[:Message]->>) {
  seen = graph<Seen> {}
  write seen-[:senders]-> { unique by (address), address: m.From }
  return count(seen-[:senders]->)
}
```

Nothing reaches a system; a `node` declares the shape and `graph<…> {}` makes an empty one.

### build-a-record

Build a record in memory to pass to a function
search: build record object struct value construct pass argument node shape in memory

```program
node Lead {
  name: <text>
  email: <text>
}

function `Lead From`(m: <mail-[:Message]->>) {
  return graph<Lead> { name: m.Subject, email: m.From }
}
```

### call-a-function

Call a function of your own and use what it returns
search: function call helper reuse return result compose define parameters arguments

```program
function `Shout`(s: <text>) {
  return "${Text.upper(s)}!"
}

function `Intake`(m: <mail-[:Message]->>) {
  return `Shout`(m.Subject)
}
```

### value-by-condition

A value chosen by a condition
search: if then else expression conditional ternary choose either case switch inline when otherwise

```body
label = Text.includes(m.Subject, "urgent") ? "urgent" : "normal"
```

`if` is a statement only; inside an expression write `c ? a : b`.

### only-act-when

Only act when a condition holds
search: if condition when only guard statement branch else skip unless

```body
if (Text.includes(Text.lower(m.Subject), "urgent")) {
  write m-[:Replies]-> { Body: "On it today." }
} else {
  write m-[:Drafts]-> { Body: "Thanks, we will reply this week." }
}
```

### maybe-missing-value

A value that may be missing, with a fallback
search: missing absent null undefined optional fallback default coalesce empty or else nullish

```body
file = only(m-[a:Attachments WHERE a.Name == "notes.txt"]->)
size = coalesce(file?.Size, 0)
```

What may be missing (`first`, `only`, `xs[i]`, an optional field) must be given a fallback or tested.

### read-through-maybe-absent

Read a field through a record that may be absent
search: optional chaining question dot safe navigation field of maybe absent null record read through

```program
function `Title`(n: <gh-[:Notification]->>) {
  title = only(n-[:Issue]->)?.Title
  return coalesce(title, n.Title)
}
```

`x?.F` is absent when `x` is; `x.F` is refused until `x` is tested.

### fail-the-run

Fail a run with a reason
search: fail error throw raise abort stop exception reason invalid

```body
if (m.Subject == "") { fail("the email has no subject") }
```

There is no `throw` or `try`; a failed run says its reason in `listen-fire runs show`.

### see-a-value

See a value in a test run
search: print debug log console inspect show value output return test run see result trace

```body
return { subject: m.Subject, files: count(m-[:Attachments]->) }
```

`listen-fire run` prints what the function returns; `listen-fire runs show` lists each write with its fields.

### text-template

Put values into text
search: string interpolation template format text concatenate join string variable insert message multi line

```body
line = "From ${m.From}: ${m.Subject} (${count(m-[:Attachments]->)} files)"
```

`+` only adds numbers; text is joined by `${…}`.

### text-helpers

Change, split or search text
search: lowercase uppercase trim split includes contains substring replace length text string

```body
words = Text.split(Text.lower(Text.trim(m.Subject)), " ")
asks  = Text.includes(m.Body, "?")
```

### pull-a-pattern

Pull a pattern out of text
search: regex regular expression match pattern extract find number code id parse text

```body
ticket = Text.regexExtract(m.Subject, "#([0-9]+)", 1)
```

### parse-a-number

Read a number from text
search: parse number integer float convert text to number cast numeric

```body
n = Number.parse(m.Subject)
if (n == null) { fail("no number in the subject") }
```

### todays-date

Today's date, written out for a person
search: today date now current time clock timestamp current_date datetime format display pretty print month day year

```body
today = Date.today("Europe/London")
line  = Date.format(today, "dddd D MMMM YYYY")
```

`Date.today` reads the run's pinned instant, so every read in one run gives the same day.

### date-arithmetic

Add days to a date, or compare dates
search: date add days subtract plus minus deadline due later earlier compare before after week ago

```body
due  = Date.addDays(Date.today("Europe/London"), 14)
late = m.Date < Date.addDays(Date.today("Europe/London"), -7)
```

### format-money

Write an amount of money or a large number
search: money currency format amount price dollars euros pounds number thousands separator grouped compact

```body
price = Currency.formatFigure(1234.5, "EUR")
big   = Number.format(1200000, "grouped")
```

### list-maths

Sum, average or find the largest in a list of numbers
search: sum total add up average mean max min largest smallest numbers list maths aggregate

```body
sizes = m-[:Attachments]->.Size
total = List.sum(sizes)
most  = List.max(sizes)
```

### map-and-filter

Transform or filter a list
search: map filter transform list each element lambda closure arrow function keep drop select

```body
names = m-[a:Attachments]-> { return a.Name }
kept  = filter(names, (n) => Text.includes(n, ".pdf"))
upper = map(kept, (n) => Text.upper(n))
```

### look-up-by-key

Look a value up by a key
search: dict dictionary map lookup key value object keyed by record index name table

```body
labels = { bug: "Bug report", ask: "Question" }
by     = List.keyBy(m-[:Attachments]->, (a) => a.Name)
note   = coalesce(by["notes.txt"]?.Name, labels.ask)
```

A lookup may find nothing, so it is read through `?.` or `coalesce`.

### extract-fields

Extract structured fields from text
search: extract parse structured fields from text email body ai model schema node pull out information entity

```program
node Order: "the order this email is about" {
  number: <text> "the order number"
}
function `Read Order`(m: <mail-[:Message]->>) {
  order = extractOne([m.Subject, m.Body], Order)
  if (order == null) { fail("no order in this email") }
  return order.number
}
```

The descriptions are the model's instructions; `extract` returns a list, `extractOne` one or absent.

### ai-value

Compute one value with a model's judgement
search: ai model llm judgement classify categorise summarise summary prompt generate decide

```body
kind = ai("one of: bug, question, other — for this email: ${m.Subject}")
```

### email-attachments

Read the files attached to an email
search: attachments files pdf document email attached read file content

```body
files = m-[a:Attachments WHERE a.`Content Type` == "application/pdf"]->.File
text  = File.read(first(files))
```

### wait-for-a-reply

Wait for a reply, with a timeout
search: await wait reply response answer timeout race thread later park resume

```body
ops = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
if (ops == null) { fail("no #general channel") }
msg = write ops-[:Messages]-> { Message: "Who takes ${m.Subject}?" }
r = race(() => {
  reply = await msg-[:Replies]->
  return reply.Message
}, () => { await sleep(1d) })
```

### wait-for-a-button

Offer buttons and wait for a press
search: buttons button press click approve approval decide yes no interaction choice slack

```body
ops = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
if (ops == null) { fail("no #general channel") }
msg = write ops-[:Messages]-> { Message: "File ${m.Subject}?", Buttons: [{ Text: "Yes", Value: "yes" }] }
r = race(() => {
  press = await msg-[:Interactions]->
  return only(press-[:Actions]->)?.Value
}, () => { await sleep(2d) })
```

### pause-a-while

Pause the run for a while
search: sleep delay pause wait later hours days minutes postpone defer

```body
await sleep(2h)
write m-[:Replies]-> { Body: "Following up." }
```

A parked run costs nothing while it waits.

### do-several-at-once

Do several things at once and wait for all of them
search: parallel concurrent all at once together simultaneously fan out promise

```body
r = all(
  () => { return Text.upper(m.Subject) },
  () => { return count(m-[:Attachments]->) },
)
```
