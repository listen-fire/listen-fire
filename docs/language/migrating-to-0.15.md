# Migrating to 0.15

0.15.0 opens a new compatibility key: it reads pins of `0.15.x` only. A project pinned to `0.14.x` is refused by name until it is upgraded, and `listen-fire upgrade` moves its pin once every file checks clean.

One idea runs through the release: **a type says what the run will meet.** A name is never a word the language reads as itself; `coalesce` answers the kinds its arguments hold; a key or a field that may be empty says so; and a collection in no order is never read as if it had one. 0.14 let each of these check clean, and the run failed or answered something arbitrary.

## Contents

- [1. How the pin moves](#1-how-the-pin-moves)
- [2. A word an expression reads as itself is never a name](#2-a-word-an-expression-reads-as-itself-is-never-a-name)
- [3. `coalesce` is typed as `a ?? b`](#3-coalesce-is-typed-as-a--b)
- [4. Airtable and Google Sheets cells that can be empty](#4-airtable-and-google-sheets-cells-that-can-be-empty)
- [5. A `List.groupBy` or `List.keyBy` key that may be absent](#5-a-listgroupby-or-listkeyby-key-that-may-be-absent)
- [6. The records a block answers come in the walk's order](#6-the-records-a-block-answers-come-in-the-walks-order)
- [7. A whole program](#7-a-whole-program)
- [8. Diagnostic code index](#8-diagnostic-code-index)

## 1. How the pin moves

- `listen-fire upgrade` checks every movement file as a move up from its pin. 0.15 adds no rewrite: each change below is a refusal the author fixes by hand, because each fix chooses a value (a name, a fallback, an order).
- The pin (`engine:` in `lf.yaml`) moves to `0.15.0` only when every file then checks clean. Otherwise it stays, and the command lists what is left.
- 0.15 changes what a run reads in one place: an Airtable checkbox left empty is `false` and an empty list field is `[]`, where 0.14 read both as absent (section 4).

## 2. A word an expression reads as itself is never a name

`true`, `false`, `null`, `and`, `or`, `not`, `in`, `contains`, `exists`, `if`, `then`, `else` and `end`, in any letter case, are refused as a binding, a parameter, an alias or a function name (`MOV_V5_HIDES_BUILTIN`). 0.14 checked `true = 5` clean, and every later `true` was the literal.

| 0.14 | 0.15 |
|---|---|
| `end = Date.addDays(start, 7)` | `deadline = Date.addDays(start, 7)` |
| `(in) => …` | `(item) => …` |

## 3. `coalesce` is typed as `a ?? b`

`coalesce` answers the union of what each argument it reaches holds, as TypeScript types `a ?? b`. An argument that is always there is the last one reached. 0.14 typed arguments of different kinds as unknown, and every later check said nothing.

| 0.14, checked clean | 0.15 |
|---|---|
| `held = coalesce(i.Text, [])` then `map(held, …)` | refused: `held` is text or an empty list (`MOV_COLLECTION_OP_NOT_A_COLLECTION`) |
| `coalesce(n, "n/a") + 1` | refused: a number or a text (`MOV_ARITH_NON_NUMERIC`); write `coalesce(n, 0) + 1` |

A fallback of the value's own kind types as before: `coalesce(tags, [])` is a list of text.

## 4. Airtable and Google Sheets cells that can be empty

Airtable leaves an empty cell out of a row. A field that can be empty is now typed `T | null`: every kind of text, a number, a date, a single select, a collaborator, a barcode, a formula, a rollup, AI text, the last-modified time and author. A Google Sheets table's every column, and a named or addressed cell's `Value`, may be absent too.

| 0.14, checked clean | 0.15 |
|---|---|
| `ops-[v:Vendors WHERE v.Spend > 0]->` | `ops-[v:Vendors WHERE v.Spend != null && v.Spend > 0]->` |
| `write crm-[:Leads]-> { Name: r.Title }` | `write crm-[:Leads]-> { Name: coalesce(r.Title, "Untitled") }`, or `Name ?: r.Title` to leave it unset |

These stay always there: a checkbox (an empty one reads `false`), a list field such as a multiple select, attachments or linked rows (an empty one reads `[]`), an autonumber, a count, the created time and the creator. A write still gives a field a value.

## 5. A `List.groupBy` or `List.keyBy` key that may be absent

The run fails at the first member whose key answers nothing, so such a key is now an error (`MOV_DICT_KEY_MAY_BE_ABSENT`; a warning in 0.14).

| 0.14, warned | 0.15 |
|---|---|
| `List.groupBy(rows, (r) => r.Owner)` | `List.groupBy(rows, (r) => coalesce(r.Owner, "Unassigned"))` |

## 6. The records a block answers come in the walk's order

A block over a walk with no `ORDER BY` answers in no order. `first`, `[0]`, `Text.join` and `reduce` over the records it answers are refused (`MOV_FOLD_NEEDS_ORDER`), as they were over the values it answers.

| 0.14, checked clean | 0.15 |
|---|---|
| `ps = c-[p:People]-> { return p }` then `first(ps)` | order the walk (`c-[p:People ORDER BY p.Name]->`), or `only(…)` where exactly one is meant |

## 7. A whole program

A grouping key with a fallback, keys sorted before they are joined, and a record tested before it is read:

```
gh = connect `@lf/github` using my_github
team = connect `@lf/slack` using team_workspace

function `Open Issues`(go: <manual-[:Invocation]->>) {
  authors = gh-[r:Repositories WHERE r.Name == "api"]->-[i:Issues WHERE i.State == "open"]-> { return i.Author }
  by = List.groupBy(authors, (who) => coalesce(who, "nobody"))
  lines = map(sort(Dict.keys(by)), (who) => "${who}: ${count(by[who])}")
  ops = only(team-[ch:Channels WHERE ch.Name == "ops"]->)
  if (!exists(ops)) { fail("no #ops channel") }
  write ops-[:Messages]-> { Message: Text.join(lines, "\n") }
}
```

## 8. Diagnostic code index

| code | what 0.15 refuses |
|---|---|
| `MOV_V5_HIDES_BUILTIN` | a name that is a word an expression reads as itself |
| `MOV_COLLECTION_OP_NOT_A_COLLECTION`, `MOV_ARITH_NON_NUMERIC`, `MOV_BUILTIN_ARG_TYPE` | a `coalesce` whose union is not what the read needs |
| `MOV_ABSENT_REQUIRED` | an Airtable or Google Sheets field that may be empty, read where a value is needed |
| `MOV_DICT_KEY_MAY_BE_ABSENT` | a grouping key that may be absent (now an error) |
| `MOV_FOLD_NEEDS_ORDER` | `first`, `[0]`, `Text.join` or `reduce` over the records an unordered walk's block answers |
