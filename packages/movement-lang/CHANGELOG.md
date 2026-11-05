# @listen-fire/movement-lang

## 0.15.2

### Patch Changes

- 430fec9: The engine's artifact carries the deep-recursion fix. A run that goes deeper than the WASM engine's stack holds ends with `CallDepthExceeded` (`MOVENG_CALL_DEPTH`, `stackRanOut: true`, its message saying the engine's stack ran out) where it crashed before, on the engine's own check or, when V8's stack runs out first, by the host. `movement-lang` exports `EngineStackRanOut`, what an engine segment throws for the second. The shadow stack goes from 2 MiB to 3 MiB, so whatever fitted before still does.
  
  A value nested past 3,000 levels is refused as it crosses to the host, by name. This ships in a patch and not under a new compatibility key: the rule about a tightened engine rule does not apply, since the cap refuses only what crashed before.
- 125360f: Checking a movement of nested closures no longer doubles in time with each level: forty nested `map` closures, near the grammar's nesting limit, check in under a second, where twenty took a minute. Which programs are accepted and every diagnostic are unchanged.
- c6f4821: Runners sharing a secrets module share each webhook: registering never replaces or narrows it, and the last holder to leave removes it. A call to a secrets module now fails after 60 s (`LF_SECRETS_CALL_TIMEOUT_MS`) instead of freezing the process, and a token refresh keeps a rotated token when only `webhook_holders` moved during it.
- c13588e: `MOV_UNKNOWN_POSITION` on a parameter type names the address to write where the catalog says which one it is: a longer walk names the record it lands on (`<chat-[:File]->>`), and a hop naming a position a connection with only one no longer has names that one. `listen-fire upgrade` lists it and applies it only with `--all`.
- e38722c: `listen-fire upgrade` settles a project in one call: a library's rewrite clears what its importers reported, where a second call was needed before.

## 0.15.1

### Patch Changes

- b2a12ef: `listen-fire example` answers two more things: listening for a Stripe failed payment and reading its invoice, and calling an MCP tool and reading its answer.

## 0.15.0

### Minor Changes

- fa0d26d: `Dict.keys(d)`, `Dict.values(d)` and `Dict.entries(d)` list a dict (a `List.groupBy` or `List.keyBy` answer, or a `{ … }` literal), in no order, and `List.distinct(list)` answers each plain value once, in the order they first appear. The wasm carries them, and the standard library table names the new `dict` parameter type. The handbook's `patterns#group-and-count` groups one level with `List.groupBy` and `sort(Dict.keys(by))`, and keeps the run's own graph for grouping deeper than one level; the expressions chapter and the reference name the four functions, and the reference lists `Dict` among the words that can't be names.
  
  `Date.daysBetween(from, to)` answers the whole calendar days from one date to another, negative when `to` is the earlier; a datetime counts as the calendar date written at its start, read exactly as `Date.addDays` reads it. It is `number | absent` when either argument may be absent or is text. The wasm carries it; the builtins, expressions and reference chapters name it, and the micro examples answer "days between two dates" with it.
- 2efc8c2: 0.15.0, a new compatibility key: a word an expression reads as itself is never a name, `coalesce` is typed as `a ?? b`, a `List.groupBy` or `List.keyBy` key that may be absent is refused, `first`, `[0]`, `Text.join` and `reduce` over the records an unordered walk's block answers, or over a list literal spreading them, are refused, a built-in inside walk brackets is spelled as outside them (`LENGTH` of a list there as `count(xs)`), and a built-in that can answer nothing (given a value that may be absent, text it may read no date from, or a pattern or money figure that may not match) types its answer `T | absent`. The engine package's schema projection types a field a record may not hold (`mayBeAbsent`) as `T | null` where it is read and `T` where it is written. A pin of `0.14.x` is refused by name ("validate it under 0.15.0 and upgrade it"). The wasm artifacts are rebuilt.

## 0.14.2

### Patch Changes

- The listen judge reads a listed hop's record from the arrival when the plan says the edge carries it, finding a carried parent by its record type.

## 0.14.1

No changes in this release.

## 0.14.0

### Minor Changes

- 0.14.0, a new compatibility key: a field is never read through a value that may be missing (`?.`), a walk off a union lands on one of its members (`is` narrows it), `lazy` and the loop guard slot are retired. See docs/language/migrating-to-0.14.md.

## 0.13.1

### Patch Changes

- 83543ba: `connect` names the adapter and the credential itself (``gh = connect `@lf/github` using my_github``, `crm = connect #acme_crm using acme` for a module that is no package), with no `import … from adapters` or `from credentials`; the import form is deprecated and still checks under a `0.13` pin. The wasm checks the new form; the handbook, the modules' examples and the authoring MCP's guidance show only it, and the handbook's programs listen to the `manual` and `cron` units by name rather than connecting them.
  
  `@listen-fire/embed`: a module the host registers from a package (`modules: [{ module: slackModule, package: "@lf/slack" }]`) is connected by that package's name, as on every host; the host's own modules are connected as `#` and their adapter type.

## 0.12.13

### Patch Changes

- The command is now `listen-fire`, no longer `lf`: every message, hint, description and handbook page that tells someone what to run names `listen-fire` (for example `listen-fire connect s3_files`, `listen-fire credential add --module webhook <name>`). Module names (`@lf/…`), `lf.yaml`, `.lf/` and `LF_*` variables are unchanged.

## 0.12.12

No changes in this release.

## 0.12.11

No changes in this release.

## 0.12.10

No changes in this release.

## 0.12.9

No changes in this release.

## 0.12.8

No changes in this release.

## 0.12.7

No changes in this release.

## 0.12.6

### Patch Changes

- Adapter protocol 2.N: a module states the protocol minor it uses (`protocolMinor` on its manifest), and lf and the engine speak 2.0–2.2 and refuse a module outside that range by name. lf checks a slot module's protocol at start, so a slot module must answer `manifest` before anything else.
