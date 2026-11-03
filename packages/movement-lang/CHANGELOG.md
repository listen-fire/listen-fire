# @listen-fire/movement-lang

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
