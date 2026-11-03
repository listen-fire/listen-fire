# @listen-fire/handbook

## 0.15.0

### Minor Changes

- a354fd1: The handbook carries the chapters on the always-connected `cron` and `manual` (`system:cron`, `system:manual`, exported as `UNIT_CHAPTERS`). Its index and `listen-fire catalog` route a schedule's or a hand-started run's author to them, and only the platform had them: elsewhere the route answered "No chapter". `system:cron` shows a schedule listen in a zone and says what a tick carries (`Fired at`, `Schedule`, `Zone`); `system:manual`, a start reading its `Text`, and a backfill. Each example checks clean. The authoring tools read them with no host; a host's own chapter of the same id takes their place.

### Patch Changes

- 9e0ee87: The reference and the expressions chapter say what `coalesce` answers as it runs: the first argument that has a value, as TypeScript's `??`. An empty text is a value, so `coalesce(pr.Body, pr.Title)` answers an empty body. The reference said "first non-empty".
- fa0d26d: `Dict.keys(d)`, `Dict.values(d)` and `Dict.entries(d)` list a dict (a `List.groupBy` or `List.keyBy` answer, or a `{ … }` literal), in no order, and `List.distinct(list)` answers each plain value once, in the order they first appear. The wasm carries them, and the standard library table names the new `dict` parameter type. The handbook's `patterns#group-and-count` groups one level with `List.groupBy` and `sort(Dict.keys(by))`, and keeps the run's own graph for grouping deeper than one level; the expressions chapter and the reference name the four functions, and the reference lists `Dict` among the words that can't be names.
  
  `Date.daysBetween(from, to)` answers the whole calendar days from one date to another, negative when `to` is the earlier; a datetime counts as the calendar date written at its start, read exactly as `Date.addDays` reads it. It is `number | absent` when either argument may be absent or is text. The wasm carries it; the builtins, expressions and reference chapters name it, and the micro examples answer "days between two dates" with it.
- 56ba35d: A recipe, `patterns#group-and-count`: a line per distinct value with its count, made by filing each record under one record per key in the run's own graph (`unique by`) and walking the keys in order, each counted. The language search answers "group", "distinct", "count per", "keys" and "dict keys" with it.
- c8e1bfe: The micro examples: a few checked lines of listen-fire doing one thing each, found by asking in your own words. The handbook exports them (`microExamples`, `searchExamples`, `renderExampleLookup`, `renderExampleIndex`); they are read from the `listen-fire` command's own copy, `crates/lf/data/examples.md`, which a build of the package carries as `examples.md`. The authoring tools serve the lookup as `showExample`, and the front page's build loop points at it. The language search's ranking rule is now one function, `scoreFields`, which both lookups share.
- c57e47c: The handbook lists every word a name can't be, `all` among them. The front page's statements entry names the words that start a statement with `all`, and says core words and namespaces are never names either; the reference lists them all (the words that start a statement, the core words and the namespaces), as the refusal of a binding does. The expressions chapter said a name matching a core word hides it with a warning; the binding is refused.
- 01bfdd4: The core peer floor is now `>=0.15.0`. The handbook's `patterns#group-and-count` recipe and its built-ins reference use `Dict.keys` and `List.distinct`, which a 0.14 core does not read, so a 0.14 host would install it cleanly and then fail on those examples.
- 05d2f0c: The reference says `coalesce` is typed as TypeScript's `a ?? b`: `coalesce(n, "n/a")` is a number or a text, and is no number (the 0.15 checker's typing).
- b1e401b: The group-and-count recipe says a `List.groupBy` key that may be missing is refused without a fallback, as the 0.15 checker does.
- 0dcc4ec: The reference lists the words an expression reads as themselves (`true`, `false`, `null`, `in`, `and`, `end`, …) among the words that can't be names, as the 0.15 checker refuses them.
- 3c4dbee: The reference, the writes chapter and the foundations chapter spell a built-in inside walk brackets as outside them (`exists(c-[:Team]->)`, `Text.lower(c.Name)`), as the 0.15 checker requires, and the prose rules refuse a CAPS walk word (`LOWER(x)`) in any chapter.

## 0.14.2

### Patch Changes

- 134ef2f: The core peer floor is now `>=0.14.0`. The handbook's examples use uses `?.`, which a 0.13 core does not read, so a 0.13 host installed it cleanly and then failed on its examples.

## 0.14.1

### Patch Changes

- 6040ec1: The prose rules read `for each` in any casing and across a line break, and the handbook's tests now hold every module's section to them (and its probes to the check a run passes, as the chapters' are), so a section that breaks a rule fails where it is written. The traversal chapter no longer quotes the phrase. The knowledge graph fixture describes the graph's per type `Changes` edge (`Company Change`, `Person Change`, `Support Ticket Change`) in place of 0.12's `Record Change`, and the handbook's catalog names a `team_whatsapp` credential so a WhatsApp example connects with `using`.

## 0.14.0

### Minor Changes

- d230f9c: The handbook teaches `x?.F`, a field read through a value that may be missing (absent when it is), and refuses `.` there as the 0.14 language does: through `only(…)`, `first(…)`, `extractOne(…)`, a named `match`, a call's result and an index read. A presence test of a record that may be missing is `exists(x)` or `x?.F != null`; `exists(xs[0])` proves every later `xs[0]`. Every example reads that way.

## 0.13.1

### Patch Changes

- 83543ba: `connect` names the adapter and the credential itself (``gh = connect `@lf/github` using my_github``, `crm = connect #acme_crm using acme` for a module that is no package), with no `import … from adapters` or `from credentials`; the import form is deprecated and still checks under a `0.13` pin. The wasm checks the new form; the handbook, the modules' examples and the authoring MCP's guidance show only it, and the handbook's programs listen to the `manual` and `cron` units by name rather than connecting them.
  
  `@listen-fire/embed`: a module the host registers from a package (`modules: [{ module: slackModule, package: "@lf/slack" }]`) is connected by that package's name, as on every host; the host's own modules are connected as `#` and their adapter type.

## 0.13.0

### Minor Changes

- 37ad00c: The reviews chapter teaches waiting as traversal: waiting on a person, `await` and `await new`, buttons on a message, a form's link (`host-links`), a deleted record ending a wait, and the values a wait captures. Every wait on a person or a system the handbook shows (chapters, front page, language search, module sections) sits in a `race` with a `sleep`, and a test holds it. The index routes to the new sections, the language search gains an `await` entry, and `callback(…)` and `await first(…)` are retired surface in the prose contract, so a host's own sections are held to it too. The writes chapter shows `Buttons` on a message and points to forms. The 0.13 migration guide's programs are checked like the README's.

### Patch Changes

- c57641a: Airtable is listened to on a table's `Changes`, walked to by name (`listen to at-[b:Bases WHERE b.Name == "Finance"]->-[t:Tables WHERE t.Name == "Expenses"]->-[c:Changes WHERE c.Kind == "created"]-> fire review`). A change is one per row an edit touched (`Kind`, and the row before and after as `Previous` and `Current`, read through with `.` once tested present (`exists(c.Current) AND c.Current.Stage == …`; a created row has no `Previous`) and typed by the table's fields when the listen narrows to one table: `Candidates Change`), and its `Record` is the row as it is now, read from Airtable. One data webhook per base a listen's tables are in, over all its tables however many the listen watches (`Changes` declares `scopedBy: "Bases"`; at a connection positioned at its base it is delivered to the connection), and one schema webhook (`tableMetadata`) per base whose tables a listen narrows: 2 per base, the most Airtable lets one OAuth integration make, which the fake Airtable now enforces (a third live webhook on a base is refused); `Tables` declares `membersChange: "pushed"`, so a table renamed into the WHERE is watched from the rename. `Bases` is cheap to list and listed again hourly. A run can wait on a table's next change (`awaitKeys`). Adapter protocol 2.6. The root's `Base` collection is now `Bases`; `Record Change`, `listenConfig`, `subscribableEvents`, `subscriptionScopeKeys` and `listEventTypes` are gone, and a 0.12 settings listen is rewritten by `listen-fire upgrade`, keeping its meaning (`field` as `c.Current.F != c.Previous.F`, with `becomes` as `c.Current.F == v AND c.Previous.F != v`; the parameter retyped to the table's changes). A cell an update empties is absent from `Current`. Every cell of `Current` and `Previous` is the value its field declares (a collaborator by its email, a select by its name, a lookup as its values), so a listen compares them by value; attachments stay as Airtable sends them, and a `field` naming one is rewritten without `safe`. A registration with no webhook held first deletes any webhook left at its door, as Airtable keeps a lapsed one 7 days; a host must give each tenant connection a door URL of its own, or one tenant's registration deletes another's webhooks. A base's `Tables` and the root's `Bases` are read from Airtable each time they are listed, so a listen listed again sees a rename at once. A base holding a table named `Base`, `Table`, `Change`, `Row` or `Tables`, or one named as another table's changes (`Candidates Change`), or a table with a link field named `Changes`, is refused where it is described, naming what to rename. The module has a handbook section. The fake Airtable models schema webhooks, renames a table (`POST /airtable/control/rename-table`) or a base (`/rename-base`), and makes a table (`/create-table`).
- cf98af4: Examples wait with `await x-[:E]->` in place of the retired `await first(x-[:E]->)`, which a 0.13 check respells. The handbook drops its common-mistakes entry against writing `await` before a bare walk, which is now the form.
- 0801793: The handbook's checked probes and the language search's control form teach what replaces `callback(…)` at 0.13: buttons on a message answered on `msg-[:Interactions]->`, and a form from `@lf/forms` answered on `form-[:Submissions]->` (the chapters' prose is rewritten separately).
- 75ea8a3: The reviews chapter's `deleted-records` says a record deleted while a run waits on it leaves the wait waiting, and to race every wait on a person or a system with a `sleep`; the reference's waiting section and its pitfalls say the same. Before, they said the wait settled empty and the code after it ran zero times, and that an `all` slot or a `map` member that awaits could be null.
- 28f6d44: `testing`'s captured adapter schemas say `listenable` on Slack's `Replies` and the ask `Response` edges, in place of the retired `awaitable` and `watchable`; Slack's `Replies` also carries `identity: "Timestamp"`.
- 16e3776: The reference chapter's manual listen is `listen to runs-[:Invocations]-> fire …`, and says the run's text and files are read off the fired function's parameter.
- 1e85960: The handbook's inbox, schedule and manual listens are written on their edges: `inbox-[e:Emails WHERE e.Key == "intake"]->`, `timer-[k:Ticks WHERE k.Schedule == "0 9 * * 1"]->`, `manual-[:Invocations]->`, each function typed by the edge it fires on (`<inbox-[:Emails]->>`). The listeners chapter says a listen is a traversal ending on the edge its events arrive on. Its captured catalog carries the 0.13 shapes of email, cron and manual.
- 1a80e92: The handbook's captured catalog carries `@lf/slack`'s `Buttons`, `Interactions` and the `Interaction` and `Action` types, from the real module, so examples that write buttons and wait for a press check against them.

## 0.12.8

### Patch Changes

- The command is now `listen-fire`, no longer `lf`: every message, hint, description and handbook page that tells someone what to run names `listen-fire` (for example `listen-fire connect s3_files`, `listen-fire credential add --module webhook <name>`). Module names (`@lf/…`), `lf.yaml`, `.lf/` and `LF_*` variables are unchanged.

## 0.12.7

### Patch Changes

- d3ca78b: The handbook's Gmail entry now mentions labelled mail and drafts: "A mailbox: run on arriving or labelled mail, search, send, reply, draft".

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
