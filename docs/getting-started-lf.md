# Getting started with `listen-fire`

`listen-fire` runs movements from a project folder on your machine. Install it with `cargo install listen-fire`, build it with `cargo build --release -p listen-fire` (the binary is `target/release/listen-fire`), or install a release.

## 1. Make a project

```
listen-fire init my-project && cd my-project
```

This writes `lf.yaml`, a starter movement in `movements/`, `externals/` and `.lf/` (run state and secrets, git-ignored). It never overwrites a file that exists. `lf.yaml` pins the engine version the project runs on, and its `core:` section chooses the modules run state, models, the judge and files come from ([core slots](core-slots.md)). The defaults need no setup.

A working project to read or copy is [`examples/lf-acme`](../examples/lf-acme): one movement, one external, a sample secrets file (copy it to `.lf/secrets.yaml`).

The starter runs straight away: `listen-fire check`, then `listen-fire run hello`.

## 2. Write a movement

`manual` and `cron` are the host's own sources, so a movement listens to them with no import:

```
function hello(run: <manual-[:Invocations]->>) {
  return "Hello, ${run.`Run by (name)`}!"
}
listen to manual-[:Invocations]-> fire hello                                    # listen-fire run hello

function digest(t: <cron-[:Ticks]->>) {
  return t.`Fired at`
}
listen to cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1"]-> fire digest           # listen-fire serve or listen-fire drain fires it
```

A system's events need its external. Put a `.mvt` file in `movements/`:

```
crm = connect #acme_crm using acme

function welcome(company: <crm-[:Company]->>) {
  write crm-[:Company]-> { Name: "Welcome ${company.Name}" }
}

listen to crm-[:Company]-> fire welcome
```

A module with no webhooks (Granola, Evertrace, Dealroom, GitHub's notifications) is polled instead: its listenable edge declares `delivery: polled` and `pollEverySeconds`, and a listen on it reads like any other (`listen to granola-[n:Meetings WHERE n.Folders CONTAINS "deals"]-> fire summarise`).

- Listens on one connection and edge with the same `WHERE` share one poll. `pollEvery` in `lf.yaml` overrides a connection's interval; a listen has none of its own.
- `listen-fire serve` polls each such edge on its interval, and runs the listens on each new arrival. The first poll only arms: what was there before fires nothing.
- `listen-fire drain` polls every edge that is due. A poll missed while nothing ran is one poll on the next drain.
- Each poll keeps its own cursor, so it asks only for what is new since the last one.
- An arrival a listen has run before runs nothing.

`listen-fire check` prints every diagnostic; fix them before running.

## 3. Connect a module

A system is reached through an external: a folder in `externals/` holding an `lf-external.yaml` that says how the host starts or reaches it.

```
listen-fire modules                  # every module this listen-fire can install (the bundled @lf/* ones), one line each, and which this project has
listen-fire modules show <module>    # what one reads, writes and listens to, read from the module itself; no credential needed
listen-fire connect <module>         # installs it and asks for its server secret, webhook secret and OAuth app
```

Read `modules show` before writing a program against a module. It lists the record types a program can read with their fields and edges, whether the module writes anything (`@lf/stripe` is read-only), the events a `listen` can name, and the credential it needs. A module whose schema comes from your own account (Airtable's tables, a spreadsheet's tabs) says so instead: its records show only once a credential is added and a movement connects it (`listen-fire catalog`).

`listen-fire catalog` prints the same notation for each connection the project's movements make, its live types included (an MCP server's tools, a CRM's fields), with the `connect` line that makes it. `--json` prints the catalog snapshot `listen-fire check` reads. A bare `listen-fire connect` prints the same list as `listen-fire modules`.

`listen-fire connect <module> --yes` asks nothing, so it works without a terminal. Each answer comes from a flag (`--setting <name>=<value>`, `--client-id`, `--client-secret`, `--redirect-port`, `--server-secret`, `--webhook-secret`) or from its default (a webhook secret is generated). When an answer has neither, the command names the flag it needs and writes nothing; `modules show` lists them under `set up`.

`ai(…)` and `extract(…)` call models: `listen-fire connect @lf/anthropic` stores your API key.

`listen-fire connect <module> --base-url <url>` points the module at a fake or a proxy instead of its provider; `--oauth-authorize-url` and `--oauth-token-url` do the same for its sign-in. [`examples/lf-attio`](../examples/lf-attio) walks Attio through end to end, against real Attio or the repo's fake.

A plugin package is an external of `kind: plugin`. `@lf/pdf` draws text as a PDF file and needs no credential:

```
# externals/pdf/lf-external.yaml
name: pdf
kind: plugin
module: "@lf/pdf"
```

```
import { `@lf/pdf` as pdf } from plugins

function report(c: <crm-[:Company]->>) {
  write crm-[:Company]-> { Name: c.Name, Report: pdf.render("Report for ${c.Name}") }
}
```

`pdf.render(text, { pageSize: "a4" | "letter", margin })` is a file (A4, 30 points of margin by default). Its writer is thin: Helvetica, no font to ship. A character outside Latin-1 (CJK, emoji) prints as `?` and the run is warned, naming `@lf/pdf`; a PDF module that embeds a font can serve the same plugin in its place.

### How listen-fire runs a module

A movement imports only modules installed in `externals/`; installing is always `listen-fire connect` (or a folder you add), never an import.

**A local module runs with your permissions.** listen-fire has no sandbox yet: a module's process can read and write what you can. Install only modules you trust.

- It starts a module's process only when a run or a check needs it. A check needs one when the movement imports a live graph such as Attio's.
- It keeps the process up while it is used, and stops it after `moduleIdleTimeout` seconds unused (in `lf.yaml`; default 300). The next call starts it again.
- When a project opens, listen-fire starts every module its movements import at once, so the open takes as long as the slowest module's start, not their sum.
- `listen-fire drain` keeps those modules up for as long as it runs: no idle stop, so no run waits on a module's start. It also starts, with them, every slot module `lf.yaml`'s `core:` names that runs as a process of its own (models, ocr, limiter, wake, files, …), and keeps those up too. A built-in slot stays inside listen-fire.
- `listen-fire serve --doors-only` starts, as it opens, only the slot modules a door calls: the limiter and the wake (and the store, secrets and movements modules, which every command opens). Never the models or ocr modules.
- Under `listen-fire serve` or `listen-fire drain`, a module no movement imports any more after an edit is stopped once the runs that began before the edit are done with it. A first-party module shares its process with others, so it is left out of that process's next start instead.
- First-party `@lf/*` modules, and any whose `lf-external.yaml` says `trusted: true`, share one Node process. Every other module gets a process of its own.
- A module that crashes starts again on its next call. A run whose call it broke fails or retries as any failed call does.
- One call may take `callTimeout` seconds (default 600).
- A module process exits when listen-fire does. A process left behind by a killed listen-fire is stopped the next time listen-fire opens the same store.
- A module's `env:` values may use `{lf}`, which listen-fire replaces with the module's own folder, `.lf/externals/<name>/` (a place for its state and logs; not the project's `.lf`, which holds listen-fire's state and secrets).
- `runtime: node 22` in `lf-external.yaml` says what the module runs on; a served module (`module:`) runs on node 22 unless it says otherwise. `listen-fire check` refuses, by name, a runtime this machine lacks or has too old.

## 4. Add a credential

```
listen-fire credential add --module <module> my_credential
```

This signs you in at the provider (OAuth) or asks for the module's fields, and stores the result in `.lf/secrets.yaml`. A movement names it after `using`: `crm = connect #acme_crm using my_credential`. `listen-fire credential list|update|delete` manage the rest. In containers and CI, set `LF_SECRET__<NAME>__<FIELD>` instead of keeping a file. Like ssh with a private key, listen-fire refuses a secrets file that other users can read; fix it with `chmod 600 <path>` (listen-fire itself always writes it that way).

## 5. Run

```
listen-fire run hello                                   # run a movement a `listen to manual-[:Invocations]->` fires
listen-fire run hello --text "Acme Robotics"            # …with its Invocation's Text (`run.Text`)
listen-fire run --event events/company_created.json     # route one event to the listens it matches
listen-fire run --event events/company_created.json --dry-run
listen-fire run --poll summarise                        # poll now the polled source of each listen that fires it
listen-fire runs                                        # the runs, most recent first
listen-fire resume [<run-id>]                           # step a parked run, or every due one
listen-fire runs rerun <run-id> [--force]               # run a failed run again, as its next attempt
```

A run that failed can be run again with `listen-fire runs rerun <run-id>`. The rerun is the same run's next attempt: it runs on the event (or manual text) the run ran on, against the movement as the project holds it now, so fix the movement first and the fix takes effect. It runs from the start. `listen-fire runs show <run-id>` lists every attempt with its status, times, writes and error, and the run's status is its latest attempt's.

- Only a run whose latest attempt failed is rerun. A run that succeeded is refused (`run <id> succeeded on attempt 2; nothing to rerun`), so running the command twice never repeats what worked.
- An attempt may have made writes before it failed: sent an email, created a record. A rerun from the start makes them again, so listen-fire refuses it and lists those writes. `--force` reruns it anyway.
- Two reruns at once: one runs, the other is refused while the first holds the run.
- `listen-fire listens replay` is a different thing: it puts a kept delivery through one listen again (see [Deliveries](#deliveries)).

What a movement returns is its run's output, as a cron job's output is. Every run records it in its history, however the run started, and `listen-fire runs show <run-id>` shows it. `listen-fire run` and `listen-fire resume` also print it when they complete the run:

```
$ listen-fire run hello
run 32bc… hello:hello completed — 0 write(s), 0 trace entries
  returned "Hello, Ada!"
```

A run started by an event (a webhook, `cron`, a poll) sends the value nowhere: it only sits in the run's history. It never reaches an external system, and no door answers with it. The history keeps up to 64 KiB of the value's JSON, and says when it cut one short. A returned file is kept as a reference to the file, never its bytes.

## 6. Serve

```
listen-fire serve [--port N] [--doors-only]
```

`listen-fire serve` receives webhooks, polls `cron` listens' ticks as each comes due (one clock per schedule and zone, however many listens share it), polls polled sources on their interval, and drains due work, so listens fire on their own. It starts only on a project that checks: with any check error it prints each one, as `listen-fire check` does, and stops (so do `listen-fire drain`, `listen-fire run --webhook` and `listen-fire resume` with no run id). A listen on a polled edge (`listen to f-[n:Notes WHERE …]-> fire a`) is polled once per connection, edge, filter the module takes and scope, however many listens share it; its first poll only sets the mark it fires from. It is polled every interval its edge declares, unless `lf.yaml` names one for the connection: `pollEvery: { <credential>: 5m }`, a connection that uses no credential named by its module. `listen-fire drain` does the same work once and exits (`--until-idle`): a tick or poll missed while nothing ran happens once on the next drain, and two workers never poll one listen at once. A listen that filters an earlier hop (`listen to f-[b:Boards WHERE b.Name == "Ops"]->-[n:Notes]-> fire a`) is watched on the boards that match: listen-fire lists them when it first serves the listen, and again as the module declares (every `membersChange: { relistEverySeconds }`, overridden per connection by `lf.yaml`'s `resolveEvery: { <credential>: <duration> }`, or on each change the module reports). A board renamed out of the filter keeps firing until the next listing. A filter matching more than `listenScopeLimit` records (default 500) suspends the listen, by name. `listen-fire listens` shows each listen on a traversal: what it watches, when it last listed it, and whether it is ok. A run's writes can fire more runs: a two-way sync hears its own write come back, and two automations can feed each other. An arrival on a record a run wrote at most `loopWindow` (in `lf.yaml`, default `20s`) before it happened continues that run's chain (`listen-fire runs show` lists a run's `chain`). The listen whose arrival would make a chain longer than `loopDepth` (default 10) runs is paused, `LISTEN_LOOP`, naming the chain's runs; its arrivals are then said, counted and not run (`listen-fire listens` shows the count), until `listen-fire listens resume <file>:<movement>`, which clears it. A write that would change nothing is never sent where its module reads a record back, so a sync's echo writes nothing and the chain ends: Affinity, Airtable, Attio, Dealroom, Evertrace, Gmail and Google Sheets do; Slack, Stripe, GitHub, Granola, Telegram, WhatsApp, email and webhook do not, and `listen-fire listens` names a listen on such a connection. `listen-fire drain --kinds poll_edge` is a pool: it claims only work of those kinds (`resume_timer`, `wake_await`, `fire_event`, `poll_edge`, `resolve_listen`, `refresh_subscription`, `settle_race`; a cron listen's ticks are `poll_edge` rows), so polls and run steps can be drained by separate fleets. Editing a movement under a running `listen-fire serve` takes effect within about a second; a set with any check error is printed once and the running one kept. Set `publicUrl` in `lf.yaml` when the outside world reaches it at another address. A listen on an edge whose module registers its own webhooks (Attio, Affinity, Airtable) gets one when `listen-fire serve` starts, made as the credential the connection names (``connect `@lf/attio` using my_credential``) and shared, as a poll is, by every listen on the same connection, edge, filter the module takes and scope, at `<publicUrl>/api/public/webhook-sync/<provider>/<credential>/edge-<16 hex>`; a restart keeps it. A delivery there is judged only against those listens. Airtable's is one per base, however many of its tables the listens watch. Airtable lets a quiet webhook lapse 7 days on: listen-fire refreshes each a day before it would, under `listen-fire serve` or a drain, and registers anew one that lapsed while nothing ran. An edit under a running `listen-fire serve` moves it with the listens: other events change it, and it is removed once no listen needs it. A registration that fails is printed once per message and tried again on the serve tick, waiting from 30 seconds doubling to an hour. A sender that posts to a URL you give it (`@lf/webhook`: Stripe, a form service, your own app) has none registered. Instead `listen-fire serve` prints each such connection's URL when it starts, `<publicUrl>/hooks/<external>/<credential>`. A delivery there is checked against the connection's signing, then against the node its listen states (`listen to stripe-[:Requests]-><Payment>`). One that does not fit is answered 400, naming the fields, and runs nothing. `listen-fire cancel <run-id>` acts on a parked or running run.

`LF_LOG=debug` adds the lines that explain why something ran nothing when nothing went wrong, such as an arrival a listen's `WHERE` refuses. Unset, they stay unsaid.

`listen-fire serve --doors-only` (or `LF_DOORS_ONLY=1`) is for compute billed by the request, which is frozen once a response is sent. It runs no drain, `/hooks/…` queues its events (answering 202 with the rows queued) instead of running them inside the request. `listen-fire drain` workers run the work, started on a schedule or by the [wake slot](core-slots.md#the-wake)'s module.

### Deliveries

Every delivery a door takes is kept as a receipt: the events it produced, and the request it was received as (its body, as received but for the fields its module declares may hold a credential, and only the headers its module declares it reads; never a signature). `listen-fire deliveries` lists them, most recent first (`--subscription <id>`, `--since <instant | 6h | 2d>`, `--json`), `listen-fire deliveries show <id>` prints one with its events and the runs they started, and `listen-fire runs show` names the delivery a run came from. The request may hold personal data, so `deliveries show` prints it only with `--request`.

- **Redelivery.** A provider that sends its own delivery id lets the door keep a repeat out: it answers 200 with `duplicate: true` and runs nothing. A signed external declares the header in its `lf-external.yaml` (`webhook: { deliveryIdHeader: x-github-delivery }`) or its manifest (`inbound.deliveryId: { header }`); a module that checks its own inbound returns `deliveryId` from `checkInbound`; Without an id every delivery is its own, as before; an event's `idempotencyKey` still dedupes at drain.
- **Inline deliveries.** `/hooks/…` under a normal `listen-fire serve`, and `listen-fire run --webhook`, run their events in the request. The receipt is written first and says `inline`, so a crash before the runs leaves a receipt with no runs, which can be replayed through its listen.
- **Replay.** A listen that could not judge an arrival (its filter reads a field the module could not read, as when Slack's `conversations.info` fails) runs nothing for it, and `@lf/system` reports `Arrival Not Judged`, naming the listen and the delivery. Once the provider answers again, `listen-fire listens replay <file>:<movement> --delivery <id>` (or `--event <the event's Event Id>`) reads the kept request again with its module, making its lookups afresh but not checking its signature again (the request is listen-fire's own copy; a module that checks its own requests is told it is a replay), and puts the arrivals the delivery brought through that listen alone (a module that reads from a cursor, as Airtable does, reports later changes too, and those are left alone). A polled delivery kept the arrivals the poll read, and those are judged again, the module asked nothing. The delivery's other listens are left as they are. A listen that ran the arrival before runs nothing (`--force` runs it again), and one that still cannot judge it is reported again as the next attempt (the command exits 1).
- **Retention.** The drain forgets a delivery older than `deliveries: { retainDays: 14 }` in `lf.yaml` (a whole number of days, at least 1), unless one of its runs is still running or parked or one of its events is still queued; it forgets the request of a delivery that old in any case. The runs it started stay. A delivery older than that cannot be replayed through a listen.
- **`--ephemeral`** keeps its receipts in the session's temporary state, so they go with the session; `listen-fire deliveries` in the same project will not list them.

## 7. Upgrade a project

> `engine:` in `lf.yaml` is the language version the project is pinned to: a release's version, such as `0.13.0`. This listen-fire reads every pin of its own compatibility key (under 0.x, the minor: `0.13`). A newer pin is refused with "upgrade listen-fire"; an older key is refused with "run `listen-fire upgrade`".

`listen-fire upgrade --check` prints what would change; `listen-fire upgrade` rewrites the movement files into the current language version and sets `engine:` in `lf.yaml` to it.
