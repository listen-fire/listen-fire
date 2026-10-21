# Listen-Fire

Listen-Fire runs small programs over the systems a team already uses. A program is a plain text file with a `.mvt` extension, written in a language called movement: it names the systems it touches, traverses them as graphs of records joined by edges, and moves data between them.

This repository is the language: the parser, checker and engine (Rust, compiled to WebAssembly), the `lf` command, the modules that connect systems, and the embedding kit. The hosted platform that runs movements for teams is a separate repository, `lf-platform`, in the same GitHub organisation. This repository serves language version 5 and later; upgrading an older automation is the platform's.

## Listen and fire

An automation **listens** to something in one of your systems and **fires** a named automation in response. That is the whole shape of a program, and it is where the name comes from.

```
import { `@lf/email` as email, `@lf/attio` as attio } from adapters
import { acme_main } from credentials

inbox = connect email
crm   = connect attio using acme_main

function `Inbound Intake`(msg: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    unique by (Name)
    Name: msg.Subject
  }
}

listen to inbox { key: "intake" } fire `Inbound Intake`
```

The event that arrives is a *position*: a point in the graph of the system it came from. From there the program traverses to related records, fans out across them, and writes into other systems along their own edges. `unique by` makes a repeat update an existing record instead of duplicating it.

The language lives in [`packages/movement-lang`](packages/movement-lang). The reference is the handbook under [`packages/handbook/chapters`](packages/handbook/chapters); `foundations.ts` and `anatomy.ts` are the two to start with.

## What you can connect

Each system is reached through an adapter, which presents it as a graph. The adapters in the tree are:

| adapter | system |
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
| `evertrace` | Evertrace |
| `dealroom` | Dealroom |
| `cron` | a schedule |
| `manual` | an on-demand run |

Beyond these, an adapter can also live outside this repository and be reached over a wire protocol; see [`docs/contracts/adapter-protocol.md`](docs/contracts/adapter-protocol.md).

## Repository layout

- [`crates/`](crates): the Rust crates: parser, checker, engine, language service, module wire and kit, and the `lf` command (`crates/lf`).
- [`packages/movement-lang`](packages/movement-lang): the wasm artifacts, their bindings, the version table, the expression AST and the catalog types.
- [`packages/movement-engine`](packages/movement-engine) (`@listen-fire/engine`): the host contract, the Rust shim and the embed kit. [`packages/engine-contracts`](packages/engine-contracts), [`packages/module-kit`](packages/module-kit) and [`packages/module-runtime`](packages/module-runtime): the contracts and kits modules are written against.
- [`packages/handbook`](packages/handbook): the language handbook.
- [`modules/`](modules): the modules that connect systems.
- [`apps/cli`](apps/cli): the `lf` command's TypeScript tests and fixtures.
- [`docs/`](docs/README.md): the guides and the versioned contracts.

## Developing

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, the tests and how to release.

## Licence

Apache License 2.0. See [`LICENSE`](LICENSE), and [`NOTICE`](NOTICE) for third-party attributions.
