<!-- hero:start -->
# Listen-Fire

**The automation language for agents.**

Your agent acts when you ask it to. Most of what you want done happens when you aren't asking: an email arrives, it's 8:30, a deal moves stage. Waking the agent for each of those costs a model call every time, and no two calls do quite the same thing.

With Listen-Fire you ask once. You tell your agent:

> Every weekday at 8:30, post the GitHub notifications that need me to Slack as one message.

It writes a program:

```
gh   = connect `@lf/github` using my_github
chat = connect `@lf/slack` using my_slack

function triage(t: <cron-[:Ticks]->>) {
  lines = gh-[n:Notifications WHERE n.Reason IN ["review_requested", "mention"] ORDER BY n.`Updated At` DESC]-> {
    url = coalesce(n-[:`Pull Request`]->.`HTML URL`, n-[:Issue]->.`HTML URL`, "")
    return "• ${n-[:Repository]->.`Full Name`}: ${n.Title} (${n.Reason}) ${url}"
  }
  if (count(lines) == 0) { return "nothing needs you" }
  channel = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
  if (channel == null) { fail("no #general channel") }
  write channel-[:Messages]-> { Message: "GitHub needs you:\n${Text.join(lines, "\n")}" }
}

listen to cron-[t:Ticks WHERE t.Schedule == "30 8 * * 1-5"]-> fire triage
```

Its first draft used GitHub's JSON name for the link, and `listen-fire check` refused it before anything ran:

```
$ listen-fire check
movements/triage.mvt:6:11 error MOV_UNKNOWN_PROPERTY gh.Pull Request has no field 'html_url' — it has: Number, Title, … HTML URL, …
```

The agent fixed it from that list. Now every weekday it posts this, with no model and no tokens:

```
GitHub needs you:
• acme/api: Retry webhook deliveries with backoff (review_requested) https://github.com/acme/api/pull/42
• acme/api: Webhook retries double-charge on timeout (mention) https://github.com/acme/api/issues/57
• acme/web: Move settings to the new layout (review_requested) https://github.com/acme/web/pull/318
```

You can read off the program exactly what it can reach: your GitHub notifications and the issues and pull requests they're about, and one Slack channel. It never holds a key; the engine does. Nothing in a notification can add a step or reach anything else.

All of that output is real. [`examples/github-triage`](examples/github-triage) reproduces it from a clone, with stand-ins for GitHub and Slack and no accounts.
<!-- hero:end -->

## How it works

```mermaid
flowchart LR
  A["Agent reads the handbook,<br>writes a .mvt program"] --> B["Engine checks it"]
  B --> C["Something happens:<br>an email, 8am, a CRM change"]
  C --> D["Engine runs the program<br>(no model needed)"]
  D --> E["Writes land in Slack,<br>the CRM, a sheet"]
```

1. **An agent writes a program**: a short text file (`.mvt`) in a language made for moving data between systems. A person can write or review one too.
2. **The engine runs it whenever that happens**, the same way each time. No model is needed to run a program; a program may call one for a single step (`ai(…)` to draft text, `extract(…)` to produce structured data from text).
3. **Every run is recorded**: the event it started from, what it read, and what it wrote.

## Fastest path to a first run

Install the `listen-fire` command (macOS or Linux; it verifies the download and keeps the binary and its modules together):

```sh
curl -fsSL https://raw.githubusercontent.com/listen-fire/listen-fire/main/scripts/install.sh | sh
```

The archives it installs are on the [releases page](https://github.com/listen-fire/listen-fire/releases) if you would rather unpack one yourself; `cargo install listen-fire --version 0.13.1` and, from a clone, `cargo build --release -p listen-fire` work too.

Then:

```sh
listen-fire init my-project && cd my-project
listen-fire check
listen-fire run hello
```

```
$ listen-fire run hello
run efde8ee1-… hello:hello completed — 0 write(s), 0 trace entries
  returned "Hello, <username>!"
```

`listen-fire init` writes a project folder: `lf.yaml`, a starter program in `movements/hello.mvt`, and `.lf/` for run state and secrets. The starter listens to `manual`, a built-in source that fires when you run it by hand, so it needs no account and no key. `listen-fire runs` lists every run and `listen-fire runs show <run-id>` opens one.

[Getting started with `listen-fire`](docs/getting-started-lf.md) goes on to connect a system (`listen-fire connect @lf/attio`), add a credential, route a recorded event through your programs (`listen-fire run --event …`) and serve webhooks (`listen-fire serve`).

**What it connects to:** Slack, email and Gmail, WhatsApp, Telegram, Attio, Affinity, Airtable, Google Sheets, Google Drive, Dropbox, Granola meeting notes, GitHub, Stripe, a schedule, and your own system through a module ([connect anything](#connect-anything)).

**Where it runs:** as one binary on your machine; as the same binary split into a web-facing service and on-demand workers on cloud compute that can scale to zero; or inside your own Node or Rust product ([deploy options](#deploy-options)).

## Reading a program

A program **listens** to something and **fires** a named function in response. That is the whole shape of a program, and it is where the name comes from. In the program above, `listen to cron-[t:Ticks WHERE t.Schedule == …]-> fire triage` runs `triage` every weekday at 8:30.

Each system appears to the program as a graph of records joined by edges:
- `gh-[n:Notifications WHERE …]->` is "my GitHub notifications that match", walked one at a time as `n`.
- ``n-[:`Pull Request`]->`` follows a notification to the pull request it's about.
- `write channel-[:Messages]-> { … }` adds a message to a Slack channel.

The program starts from what arrived, follows edges to related records, and writes along other systems' edges. It never handles an ID, an API shape or a key. The language lives in [`packages/movement-lang`](packages/movement-lang) and the handbook in [`packages/handbook/chapters`](packages/handbook/chapters); [`foundations.ts`](packages/handbook/chapters/foundations.ts) and [`anatomy.ts`](packages/handbook/chapters/anatomy.ts) are the two to start with.

## Worked example: CRM intake at a venture fund

Listen-Fire grew out of one job: keeping a venture fund's CRM up to date from email, meeting notes and Slack, without an associate retyping it. That job is the case study the rest of this README generalises from.

The fund's programs do what the example above does, and then what the language is for. A company that arrives by email lands in Attio once, however many times it is mentioned (`unique by`, with `FUZZY` matching so "Acme" and "Acme Inc" are one record). Meeting notes from Granola attach to the company they were about. The fields of an attached deck are pulled out with `extract(…)`, the one step that calls a model. A cold inbound waits for a partner's tap in Slack before it is added (the handbook's [reviews chapter](packages/handbook/chapters/asks.ts) covers waiting). [`examples/lf-attio`](examples/lf-attio) is a runnable Attio project with its own walkthrough.

## Deploy options

**One binary.** `listen-fire serve` receives webhooks, fires scheduled programs, polls systems that have no webhooks, and runs due work. Run state lives in SQLite under `.lf/`. This is enough for one machine. See [Getting started, section 6](docs/getting-started-lf.md#6-serve).

**Cloud, scaling from zero.** The same binary splits into two commands. `listen-fire serve --doors-only` answers webhooks by queuing them (so it suits compute billed by the request), and `listen-fire drain --until-idle --max-seconds N` is a worker that claims queued work, runs it, and exits when nothing is due. State lives in Postgres, containers keep none, and any number of workers can drain at once. [`deploy/lf`](deploy/lf) holds the image and [its guide](deploy/lf/README.md) describes the platform shape: a service, a scheduled or queue-triggered job, and an optional wake module that starts a worker the moment work is due. A local trial runs under Docker Compose.

**Inside your product.** The engine runs in your own Node process as WebAssembly, with your product defined as one more system a program can read and write, each customer as a tenant, and every outside call answered by a host you build. [`docs/embedding.md`](docs/embedding.md) is the guide and [`examples/embed-saas`](examples/embed-saas) is a small HTTP app with an end-to-end test. The engine is a Rust crate too: [`examples/rust-embed`](examples/rust-embed) runs programs from a Rust host with its own tests.

**The hosted platform.** The web app, the API, the review pages and the agent connector that run programs for teams are a separate repository, `lf-platform`, in the same GitHub organisation.

## Talking to it from agents

The handbook is the interface an agent uses. It ships in this repository as data ([`packages/handbook`](packages/handbook)): a [front page](packages/handbook/front_page.ts) that names where the language differs from TypeScript and the few ideas it adds, chapters addressed by anchor, and a keyword search over built-ins, recipes and system behaviour. Every example on the front page is checked by the engine in the handbook's tests, so it cannot teach something that does not compile. The same content is published at [listen-fire.github.io/listen-fire/docs/next](https://listen-fire.github.io/listen-fire/docs/next/).

An agent's loop with `listen-fire`:

1. Read the handbook's front page, then look up what the program needs.
2. Write the `.mvt` file into `movements/`.
3. `listen-fire check`: every diagnostic names the rule it broke, with the file and line.
4. `listen-fire run --event <recorded-event.json>`, or `--dry-run`, to see what the program would do; `listen-fire runs show <run-id>` to read the trace.

The hosted platform exposes the same handbook, the search, and save, run and inspect to agents over MCP (the Model Context Protocol), so an agent in a chat can author and run a program without a terminal. For editors, `listen-fire lsp` is a language server over stdio; [`docs/editor-zed.md`](docs/editor-zed.md) wires it into Zed.

## Connect anything

The engine knows no system. Everything a program touches is a module: a separate program that presents one system as records joined by links, and that handles its sign-in, rate limits and paging. A project installs the modules it needs (`listen-fire connect @lf/attio`), and a program imports only what is installed. Two sources are built in and need nothing: `manual`, a run you start by hand, and `cron`, a schedule.

The ready-made modules in this repository today, each a starting point rather than a fixture of the language:

| module | system |
|---|---|
| `slack` | Slack |
| `email` | inbound and outbound email |
| `gmail` | one Gmail mailbox, read and written as itself |
| `whatsapp` | WhatsApp, via the Meta Cloud API |
| `telegram` | Telegram, via the Bot API |
| `attio` | Attio |
| `affinity` | Affinity |
| `airtable` | Airtable |
| `google_sheets` | Google Sheets |
| `google_drive` | Google Drive |
| `dropbox` | Dropbox |
| `granola` | Granola meeting notes |
| `github` | GitHub notifications, pull requests and issues |
| `stripe` | Stripe events, customers, invoices and subscriptions (read-only) |
| `evertrace` | Evertrace |
| `dealroom` | Dealroom |

Any other system is a module away. A module is an HTTP server speaking a [versioned protocol](docs/contracts/adapter-protocol.md), in whatever language you like: [`examples/lf-acme`](examples/lf-acme) is a CRM adapter in one JavaScript file, and [`examples/rust-module`](examples/rust-module) serves an adapter and a plugin from Rust. A project reaches a module through a folder in `externals/` that says how: a command the host starts, a URL already serving, or a package.

The same holds for everything else the engine needs. Where runs are stored, which models answer `ai(…)`, where files go, what settles whether two records are the same, how workers are woken: each is a [slot](docs/core-slots.md) a module fills, with a default that needs no setup and an alternative you can swap in or write. Plugins add functions a program can call: `@lf/pdf` renders one, and [`examples/lf-custom-plugin`](examples/lf-custom-plugin) adds your own.

## Repository layout

This repository is the language: the parser, checker and engine (Rust, compiled to WebAssembly), the `listen-fire` command, the modules that connect systems, and the embedding kit. It serves the language of its own release; upgrading an older program is the platform's.

- [`crates/`](crates): the Rust crates: parser, checker, engine, language service, module wire and kit, and the `listen-fire` command (`crates/lf`).
- [`packages/movement-lang`](packages/movement-lang): the wasm artifacts, their bindings, the version table, the expression AST and the catalog types.
- [`packages/movement-engine`](packages/movement-engine) (`@listen-fire/engine`): the host contract, the Rust shim and the embed kit. [`packages/engine-contracts`](packages/engine-contracts), [`packages/module-kit`](packages/module-kit) and [`packages/module-runtime`](packages/module-runtime): the contracts and kits modules are written against.
- [`packages/handbook`](packages/handbook): the language handbook.
- [`modules/`](modules): the modules that connect systems.
- [`apps/cli`](apps/cli): the `listen-fire` command's TypeScript tests and fixtures.
- [`examples/`](examples): runnable projects: a `listen-fire` project, the Attio walkthrough, a custom plugin, the embedded engine in Node and in Rust, and a module served from Rust.
- [`docs/`](docs/README.md): the guides and the versioned contracts. [`docs/positioning/`](docs/positioning): the hero variants for positioning tests.

## Developing

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, the tests and how to release.

## Licence

Apache License 2.0. See [`LICENSE`](LICENSE), and [`NOTICE`](NOTICE) for third-party attributions.
