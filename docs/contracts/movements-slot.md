# The movements slot's methods

Part of [the adapter protocol](adapter-protocol.md), version 2 (an addition within it; no version of its own).

A movements module is where the project's movement files live. lf asks it for what it holds, and:

- lists every movement file, the ones others import included
- reads one by its path
- writes one back by version, for `lf upgrade` and `lf init`

The default, `@lf/folder-movements`, is the movements folder `lf.yaml` names, in process. A module of your own fills the slot when the files are kept somewhere else, such as a platform's per-tenant store.

**A module only stores.** Parsing, checking and running a movement stay in lf. `lf.yaml` and the externals folder stay local files: `lf.yaml` is what names the slots.

## Installing one

A folder in the project's externals folder, with an `lf-external.yaml`:

```yaml
name: acme_movements
kind: core
slot: movements
url: https://movements.example.com   # a remote module; or command: [node, movements.mjs], started in this folder
settings:                            # what lf asks it with on every request
  - { name: tenant, label: the tenant whose movements these are }
```

`lf.yaml` names it for the slot: `core: { movements: acme_movements }`.

## Its own settings come from outside it

The settings come from the environment (`LF_SECRET__ACME_MOVEMENTS__EXTERNAL=acme_movements` with `LF_SECRET__ACME_MOVEMENTS__TENANT=…`) or the project's secrets file, never from the module and never from the secrets slot. `lf connect acme_movements` writes them to the secrets file.

- A project naming a movements module with settings neither source holds is refused as it loads: "the movements module's own settings come from LF_SECRET__… or the secrets file, not from the secrets slot".
- `lf upgrade` loads its project without that check, and makes it again before it reaches the module.
- A module that declares no required setting has nothing to bootstrap, and is not refused.
- Why not the secrets slot: a platform sets a process's values (the tenant) in one place for both slots that are read before anything else, and `lf lsp` reads the files even when the secrets slot cannot open.

## The envelope

The store slot's envelope ([store-slot.md](store-slot.md#the-envelope)): adapter protocol 2's HTTP, one request at a time, the install's settings on every request.

## Methods

| method | params | result |
|---|---|---|
| `movements.list` | `{}` | `[{ path, version? }]`: every movement file |
| `movements.read` | `{ path }` | `{ text, version }`, or `null` when nothing is at `path` |
| `movements.write` | `{ path, text, expectedVersion }` | `{ kind: "written", version }`, `{ kind: "conflict", current }` or `{ kind: "read_only", reason }` |

`current` is the version there now, or `null` when there is none. There is no delete and no watch: nothing in lf deletes a movement file.

### Paths

A `path` is relative to the project's movements folder, `/`-separated and ending `.mvt`: `orders/sync.mvt`.

- No segment may be empty, `.` or `..`, and no `\` is allowed. A file named only `.mvt` has no name and is refused too.
- A module refuses any other path as `bad_request`, on `read` and `write`. lf refuses a listed path that is not one, naming the module and the path.
- The path is relative to the movements folder, not the project, because the folder is `lf.yaml`'s `movements:` setting, which a served module cannot see. Every identity lf keeps (a run's `file`, a listen's pipeline, a subscription, the name another movement imports) is already relative to it.
- lf names a file by its path without `.mvt` (`orders/sync`). Messages and editor links show `<movements folder>/orders/sync.mvt`, as they do for files on disk, whether or not that file exists.

### Order

`list` may answer in any order, and each path at most once. lf refuses a path listed twice, naming the module and the path.

lf sorts the list itself, segment by segment, each segment by UTF-16 code units. That is the order of the folder walk, so `a/b.mvt` comes before `a.mvt` and `B.mvt` before `a.mvt`. The order is the catalog's key order, so it decides which file a listen belongs to and the order `lf check` prints in.

### Versions

A `version` is a non-empty opaque string, and it changes whenever the text changes.

- **`list` may leave it out.** lf then reads that file on every scan.
- **`read` and `written` always carry it.**
- **The same text keeps its version** between two listings; a changed text changes it.
- **A listed version is the one `read` answers** for that path at that time.

### Write and conflict

`expectedVersion` must be present, as a string or `null`. A request without it is `bad_request`, as is one without `text`.

- **A string** replaces the file only if it is still at that version, and answers `written` with the new version.
- **`null`** creates the file only if nothing is at `path`.
- **Anything else** (the file is at another version, or a string for a path with nothing at it, or `null` for a path that has a file) answers `conflict` with the current version, and writes nothing.
- **The text is kept byte for byte**: a trailing newline and non-ASCII characters read back as written.

lf's use of a conflict:

- `lf upgrade` writes each rewrite with the version it read. On `conflict` it prints `<file>: changed since lf read it; nothing written (run `lf upgrade` again)`, counts the file as left, and so holds the project's pin.
- `lf init` writes its starter with `null`, only when `lf.yaml` already names a movements module. On `conflict` the file is already there, and it is skipped.

### Read-only

A module whose files come from somewhere lf cannot write (a platform's store the deployment fills) answers `movements.write` with `{ kind: "read_only", reason }`, and keeps nothing. `list` and `read` still work.

- lf then refuses by name, exit 2, writing nothing and leaving `lf.yaml` as it was: `<module> holds the project's movements read-only: <reason>. Change them where they live.`
- This holds for `lf upgrade` and for `lf init`.
- A refusal that is not `read_only` (the module is down) fails the command with the message, exit 1.

## When lf reads the files

lf asks `list`, then `read` for each file it does not already hold at the listed version, when a command opens its project (`check`, `catalog`, `run`, `serve`, `drain`, `upgrade` and the rest) and on each re-read of `lf lsp`. A long-running `lf serve` or `lf drain` asks again on an interval (below).

- lf keeps each path's version and text for the process. A listing whose version matches makes no `read`. A command reads the files twice (before and after the externals start), so the second read of an unchanged project is one `list`.
- `lf serve` and `lf drain` (without `--until-idle`) ask `list` every `LF_MOVEMENTS_REFRESH_MS` (default 5000; `0` asks on every pass of their loop) and read only the files whose listed version moved. A movements folder is read the same way, by the text of each file.
- A module that leaves `version` out has that file read at every refresh, and a file counts as unchanged when its text equals the text lf holds. The version is what makes a change visible, so a module whose version does not move with a file's text is never refreshed.
- A refresh that finds the set changed checks it first. A set that checks replaces the running one; a set that does not is kept out, with its diagnostics printed once, and the files lf had keep running. A module that fails to answer `list` is reported once per distinct message, and the files lf has stay.
- A parked run resumes from its own recorded source, not from the files, and its imports link against the files lf holds now.
- A platform running a session per tenant per job sees current files at each job.

## The tenant

lf has no notion of a tenant. A platform that runs lf for a tenant resolves it at its own door and starts lf for that tenant. A movements module that needs it declares a setting for it (above), and the platform sets it per process as `LF_SECRET__<ENTRY>__TENANT=<team id>` beside `LF_SECRET__<ENTRY>__EXTERNAL=<module>`.

- lf sends the settings on every request (`list`, `read`, `write`), so the module scopes each call to that tenant. lf never reads, names or checks the value.
- Only movements pinned to the current compatibility key run under lf. A platform's module lists only those.

## What a module must pass

Every movements module answers the same cases:

- **`commonSlotCases('movements', MOVEMENTS_METHODS)`**: its manifest names the slot and lists the three methods; an unknown method, another protocol version and a request without the module's token are refused as the protocol says.
- **`movementsSlotCases`** (`packages/module-runtime/module_wire/conformance.ts`, re-exported as movement-engine `public/module-wire`), against a module that can change its files. Paths are `conformance/<uuid>.mvt`.
  - `list` names a created file, and its version is the one `read` answers
  - `read` of a path with nothing at it answers `null`
  - create with `null` writes; a second create answers `conflict` with the current version and changes nothing
  - replace with the current version answers a new version, and the text reads back byte for byte
  - a stale version answers `conflict` with the current one and changes nothing
  - a text read or listed twice keeps its version; a changed text changes it
  - `/a.mvt`, `a/../b.mvt`, `./a.mvt`, `a//b.mvt`, `a\b.mvt`, `a.txt` and `a` are `bad_request` on `read` and `write`
  - a write without `expectedVersion` or without `text` is `bad_request` and writes nothing
- **`movementsReadOnlySlotCases`**, against a module that keeps the files read-only: `write` answers `read_only` with a reason and keeps nothing; `list` and `read` still work. A module that always changes its files skips these.

## Running the cases

- **Against a module of your own**, with the kits above, as `apps/cli/src/__test__/movements_slot_contract.test.ts` does for the test module (`movements_module/serve.ts`): serve the module, make a `SlotClient` at its address with its settings, and run each case.
- **Through lf's own client of it**: `lf --contract-movements-slot --dir <project>` serves the project's movements slot as a movements module, every method passed on through lf's client of the module `core: { movements: … }` names (or the folder module, by default, over the project's movements folder). The same cases then hold lf's side of the wire to the meaning they hold the module to. The module's settings come from the environment, as for any command; the settings a request carries are not used.

## Changes

- **2026-10-22** (within adapter protocol 2): the movements slot, its methods, and its conformance cases.
