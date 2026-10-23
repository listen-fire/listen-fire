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
| `movements.watch` | `{ cursor?, waitMs }` | `{ cursor, events: [{ kind, path, version? }] }`, or `{ resync: true }` |
| `movements.write` | `{ path, text, expectedVersion }` | `{ kind: "written", version }`, `{ kind: "conflict", current }` or `{ kind: "read_only", reason }` |

`current` is the version there now, or `null` when there is none. There is no delete: nothing in lf deletes a movement file.

### Watch

`movements.watch` holds the request until a file is added, changed or removed, or `waitMs` passes (at most 30,000). The generic rules, the cursor, the cap and `resync`, are in the [adapter protocol](adapter-protocol.md#watching-for-changes-slotwatch).

- An event is `{ kind: "added" | "changed", path, version? }` or `{ kind: "removed", path }`. A module that can change its files gives `version` on `added` and `changed`, the one `read` answers; one without it has the file read and its text compared.
- A request with no cursor answers the current cursor and no events. A cursor the module never gave answers `{ resync: true }`.
- Answering early with `events: []` is allowed. A module behind a platform whose request timeout is shorter than 30 s must do so before that limit.
- A module that cannot hold may answer every watch at once with no events; lf then waits `LF_MOVEMENTS_REFRESH_MS` (below) before asking again.
- `@lf/folder-movements` answers from the OS file watcher in about 130 ms (it waits 100 ms for a burst of writes to end). A watch with no cursor walks the folder first and answers the cursor after it. An editor that saves by writing a temp file and renaming it over the file is one `changed`, not a removal.

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

lf asks `list`, then `read` for each file it does not already hold at the listed version, when a command opens its project (`check`, `catalog`, `run`, `serve`, `drain`, `upgrade` and the rest) and on each re-read of `lf lsp`. A long-running `lf serve` or `lf drain` then follows the module's `watch` (below).

- lf keeps each path's version and text for the process. A listing whose version matches makes no `read`. A command reads the files twice (before and after the externals start), so the second read of an unchanged project is one `list`.
- `lf serve` and `lf drain` (without `--until-idle`) take a cursor from `watch`, `list` once for anything that changed since the open, then hold `watch` from that cursor. An event names a path: lf applies it to the last listing it saw and reads only the files whose version moved. A movements folder is read the same way, by the text of each file.
- On `{ resync: true }` lf takes a fresh cursor, lists once and carries on. A module that restarts answers `resync` to the cursors of its earlier life.
- An event with no `version` is treated as a listing with no version: lf reads the file and compares its text with the text it holds. A module whose version does not move with a file's text is never refreshed.
- The pause is `LF_MOVEMENTS_REFRESH_MS` (default 5000; at least 100 ms, so `0` is 100 ms), and only after a module answered at once with no events. An answer that was held, or that carried events, is followed by the next `watch` with no pause. After a failure lf waits the same pause before asking again.
- A module that does not answer `movements.watch` (its manifest lacks it) is refused when `lf serve` or `lf drain` starts, by name: `the movements module <name> does not answer movements.watch; lf serve needs it` (`lf drain needs it` for `lf drain`). `lf drain --until-idle` and every one-shot command never watch and do not need it.
- A held watch keeps a module that lf started from its idle stop, and does not hold up the module's other methods: a run reads its files while a watch is held.
- A change that finds the set changed checks it first. A set that checks replaces the running one; a set that does not is kept out, with its diagnostics printed once, and the files lf had keep running. A module that fails to answer `watch` is reported once per distinct message, and the files lf has stay.
- A parked run resumes from its own recorded source, not from the files, and its imports link against the files lf holds now.
- A platform running a session per tenant per job sees current files at each job.

## The tenant

lf has no notion of a tenant. A platform that runs lf for a tenant resolves it at its own door and starts lf for that tenant. A movements module that needs it declares a setting for it (above), and the platform sets it per process as `LF_SECRET__<ENTRY>__TENANT=<team id>` beside `LF_SECRET__<ENTRY>__EXTERNAL=<module>`.

- lf sends the settings on every request (`list`, `read`, `write`, `watch`), so the module scopes each call to that tenant. lf never reads, names or checks the value.
- Only movements pinned to the current compatibility key run under lf. A platform's module lists only those.

## What a module must pass

Every movements module answers the same cases:

- **`commonSlotCases('movements', MOVEMENTS_METHODS)`**: its manifest names the slot and lists the four methods; an unknown method, another protocol version and a request without the module's token are refused as the protocol says.
- **`movementsSlotCases`** (`packages/module-runtime/module_wire/conformance.ts`, re-exported as movement-engine `public/module-wire`), against a module that can change its files. Paths are `conformance/<uuid>.mvt`.
  - `list` names a created file, and its version is the one `read` answers
  - `read` of a path with nothing at it answers `null`
  - create with `null` writes; a second create answers `conflict` with the current version and changes nothing
  - replace with the current version answers a new version, and the text reads back byte for byte
  - a stale version answers `conflict` with the current one and changes nothing
  - a text read or listed twice keeps its version; a changed text changes it
  - `/a.mvt`, `a/../b.mvt`, `./a.mvt`, `a//b.mvt`, `a\b.mvt`, `a.txt` and `a` are `bad_request` on `read` and `write`
  - a write without `expectedVersion` or without `text` is `bad_request` and writes nothing
  - a watch with no cursor answers a cursor and no events
  - a file created after a watch is reported `added` with the version `read` answers, and a replace `changed` with the new version (the case asks again until 10 s have passed, so a module that answers at once passes)
  - an event answered once is not answered again from the next cursor, and a write between two calls appears in the second
  - two watchers from one cursor both see the change
  - an unknown cursor answers `{ resync: true }`
  - a missing or negative `waitMs`, or a cursor that is not a string, is `bad_request`
  - **`movementsWatchRemovalCase(remove)`**: a removed file is reported `removed`. The wire has no delete, so the harness passes the function that removes a file where the module keeps it.
  - **`movementsWatchCapCase`**: with nothing changing, `waitMs: 60000` is answered within 32 s. It takes about 30 s, so give it a test timeout of 40 s.
- **`movementsReadOnlySlotCases`**, against a module that keeps the files read-only: `write` answers `read_only` with a reason and keeps nothing; `list` and `read` still work, and `watch` still answers a cursor, and `resync` to one it never gave. A module that always changes its files skips these.

## Running the cases

- **Against a module of your own**, with the kits above, as `apps/cli/src/__test__/movements_slot_contract.test.ts` does for the test module (`movements_module/serve.ts`): serve the module, make a `SlotClient` at its address with its settings, and run each case.
- **Through lf's own client of it**: `lf --contract-movements-slot --dir <project>` serves the project's movements slot as a movements module, every method passed on through lf's client of the module `core: { movements: … }` names (or the folder module, by default, over the project's movements folder). The same cases then hold lf's side of the wire to the meaning they hold the module to. The module's settings come from the environment, as for any command; the settings a request carries are not used.

## Changes

- **2026-10-23** (within adapter protocol 2): `movements.watch`, so `lf serve` and `lf drain` follow the module's change events instead of listing on a timer; every movements module must answer it, and its conformance cases join the rest. `LF_MOVEMENTS_REFRESH_MS` is now only the pause after a module that answers at once with no events.
- **2026-10-22** (within adapter protocol 2): the movements slot, its methods, and its conformance cases.
