# Language versions

Version: the release's own

The language version is the toolchain release: the one semver every crate and package of a release carries (`0.12.0-rc.6`, `0.12.0`). There is no separate integer and no name.

- **A pin is a release's version.** A saved movement is pinned to the release it was written against: `MAJOR.MINOR.PATCH`, with an optional `-pre-release` (`0.12.0`, `0.12.0-rc.6`). A text of any other form is not a version.
- **The compatibility key.** A version's key is its minor under 0.x (`0.12.3` → `0.12`) and its major from 1.0 (`1.4.0` → `1`). A pre-release has its release's key (`0.12.0-rc.6` → `0.12`).
- **The rule.** A release reads a pin whose key is its own, and refuses any other by name, with the remedy. One rule, implemented twice: `compatible` and `standing` in `crates/movement-parser/src/version.rs`, `compatible` and `languageVersionStanding` in `packages/movement-lang/language_version.ts`. A test holds both to the table below.
- **This release's version** is read from one place on each side: the parser crate's `CARGO_PKG_VERSION` (`LANGUAGE_VERSION`), and `packages/movement-lang/package.json`'s `version` (`LANGUAGE_VERSION`).
- **On the wire:** the pin travels as `languageVersion` with a run's input, on `segment.open` (so an in-process adapter reads it from its segment), and on the checker's `check.program`. A remote adapter does not receive it: the adapter protocol carries no `languageVersion` today.

## The standings

| pin | release | standing |
|---|---|---|
| 0.12.3 | 0.12.0 | compatible |
| 0.12.0-rc.6 | 0.12.0 | compatible |
| 1.4.0 | 1.0.0 | compatible |
| 0.13.0 | 0.12.0 | newer |
| 2.0.0 | 1.9.0 | newer |
| 0.11.0 | 0.12.0 | older key |
| banana | 0.12.0 | malformed |
| 0.12.13 | 0.13.0 | older key |
| 0.13.0-rc.1 | 0.13.0 | compatible |
| 0.14.0 | 0.14.0 | compatible |
| 0.13.1 | 0.14.0 | older key |
| 0.14.0 | 0.13.1 | newer |
| 0.15.0 | 0.15.0 | compatible |
| 0.14.2 | 0.15.0 | older key |

## The refusals

A pin this release does not read is refused with `MOV_LANGUAGE_VERSION_UNSUPPORTED` (the checker) or `MOVENG_LANGUAGE_VERSION` (the engine), whose message is one of three, `{pin}` the pin and `{own}` this release:

- **newer:** "this automation pins language {pin}, newer than this release ({own}); upgrade the engine"
- **older key:** "this automation pins language {pin}, which this release ({own}) does not read; validate it under {own} and upgrade it"
- **malformed:** "this automation pins language {pin}, which is not a version; a pin is a release's version, such as {own}"

A compatible pin is read with nothing said: a deprecation is the CHANGELOG's to announce.

## Breaking changes

Breaking changes never break a saved movement.

- **A break lands in a new key.** A spelling retired, a construct's meaning changed, a plugin's output reshaped, an engine rule tightened: each ships in a release of a new compatibility key, never within one.
- **A changed meaning is diagnosed.** Any construct whose meaning changed gets a checker diagnostic under the new key, so "validates clean under the new release" can never hide a silent behaviour change.
  - A diagnosis with nothing to rewrite is a warning on a check for the upgrade (0.13's `MOV_AWAIT_VALUE_CAPTURED`, `MOV_AWAIT_MAY_HANG`, `MOV_FIELD_MEANING_CHANGED`). It says the rewrite may have changed what the program does, so `listen-fire upgrade` lists it, applies the rewrites it can, leaves the pin where it was and exits non-zero. `--all` moves the pin once the author has checked.
  - An upgrade by any host holds the pin the same way: moving it is what puts the program live under the new meaning.
- **The pin moves only by an explicit upgrade.** A person asks for it (`listen-fire upgrade`, the API's or an agent's upgrade). Never automatically, and never by an ordinary edit.
- **The CHANGELOG says why.** The entry for a break names the release that introduces it and why.

Movements pinned to the integer versions of earlier releases (1 to 4) are the platform's: it keeps their parser, checker and engine until they are upgraded. The integer 5 is the 0.12 line.

## Changes

- **0.12** (this rewrite): the language version is the toolchain release; a pin is a semver, read by its compatibility key. The integer versions and their names (version 5, "Dancing Wren", is the 0.12 line) retire, and so does `MOV_LANGUAGE_VERSION_DEPRECATED`.
- **0.13**: a wait and a listen are traversals of an edge its module declares listenable. Refused under a 0.13 pin: `callback(…)` (`MOV_CALLBACK_RETIRED`, replaced by hand with buttons on a message or a form from `@lf/forms`), `await first(x)` (`MOV_V5_SPELLING`, a safe fix to `await x`), the settings listen `listen to x { … }` (`MOV_LISTEN_SETTINGS_RETIRED`, rewritten as a traversal where its module says how: safely, or under `listen-fire upgrade --all` where the listen then hears something else), and a field read through a value that may be missing (`MOV_ABSENT_REQUIRED`, by hand: test it with `exists`). Changed meaning: a wait's `WHERE` reads the run's records once, when the wait is reached (`MOV_AWAIT_VALUE_CAPTURED`), and a wait whose record is deleted never resolves (`MOV_AWAIT_MAY_HANG` on each wait no `sleep` races); both are warnings on the upgrade that hold the pin until `--all`. A field whose meaning its module changed warns where it is read (`MOV_FIELD_MEANING_CHANGED`: gmail's `Labels` holds names, not ids), likewise holding the pin until `--all`. Refused because it checked clean and could never run: one alias on two hops of a traversal (`MOV_HOP_ALIAS_REPEATED`), a listen's `WHERE` reading a hop its arrivals do not carry and `WITHIN` on a hop resolved by listing (`MOV_LISTEN_UNWATCHABLE`), a wait off a record that may be missing (`MOV_ABSENT_REQUIRED`), and a listen on a connection whose module described no schema (`MOV_EVENT_UNDESCRIBED`). 0.13.0 also refused a run's walk whose later hop's `WHERE` reads an earlier hop's alias (`MOV_HOP_READS_EARLIER_HOP`); a later 0.13 release runs it, each path naming its own records, and the code is raised by nothing. A run parked under 0.12 is refused on resume (park state 3). Guide: [`migrating-to-0.13.md`](../language/migrating-to-0.13.md).
- **0.14**: a field is never read with `.` through a value that may be missing. Refused under a 0.14 pin, beyond 0.13's change rows and map members: a read through a graph record that may be missing (`t = only(…)`, `first(…)`, a named `match`, then `t.Name`), through a call's result (`only(…).F`) and through an index read (`l[1].F`, `d["a"].F`), all `MOV_ABSENT_REQUIRED` with a safe fix to `?.`, which `listen-fire upgrade` applies. Added: `x?.F`, absent when `x` is missing, evaluated as `x.F` always was. Narrowing proves a value present as before; `x?.F != null` proves `x` present, `exists(l[1])` or `l[1] != null` proves every later `l[1]`, and `d.a` and `d["a"]` are narrowed as one member. A run's walk off a union whose members land the same edge on different record types lands one of those types (`Memo | Remark`), and a read, walk or write off it is held to what every one of them has. Refused under a 0.14 pin, by hand: one that only some of them offer (`MOV_UNION_MEMBER_ONLY`; narrow the value with `is`, `if (n is <crm-[:Memo]->>) { … }`, which narrows any value that is one of several records), and a field none of them has (`MOV_UNKNOWN_PROPERTY`). 0.13 typed nothing there and checked both clean. `lazy` is retired for a closure (`MOV_LAZY_RETIRED`), replaced by hand: `x = lazy W` becomes `x = () => W`, read as `x()`, and `return lazy W` becomes `return W`; a node entry `k: lazy W` becomes a closure bound beside the node, or `k: W` to keep what the walk lands on when the node is built. `listen-fire upgrade` rewrites none of it. Guide: [`migrating-to-0.14.md`](../language/migrating-to-0.14.md).
- **0.15**: a type says what the run will meet. Refused under a 0.15 pin, each by hand: a name that is a word an expression reads as itself (`true`, `false`, `null`, `and`, `or`, `not`, `in`, `contains`, `exists`, `if`, `then`, `else`, `end`, in any letter case; `MOV_V5_HIDES_BUILTIN`); a `coalesce` read as what its union is not, now that it is typed as `a ?? b`, the union of what each argument it reaches holds (`MOV_COLLECTION_OP_NOT_A_COLLECTION`, `MOV_ARITH_NON_NUMERIC`, …); a read needing a value of an Airtable field that can be empty or a Google Sheets cell, now `T | null` (`MOV_ABSENT_REQUIRED`); a `List.groupBy` or `List.keyBy` key that may be absent (`MOV_DICT_KEY_MAY_BE_ABSENT`, an error where 0.14 warned); and `first`, `[0]`, `Text.join` or `reduce` over the records a block answers from a walk with no `ORDER BY` (`MOV_FOLD_NEEDS_ORDER`). Changed reading, with `@lf/airtable`: a checkbox Airtable leaves out of a row is `false`, and a list field `[]`, where 0.14 read both as absent. Guide: [`migrating-to-0.15.md`](../language/migrating-to-0.15.md).
