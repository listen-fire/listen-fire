# Migrating to 0.14

0.14.0 opens a new compatibility key: it reads pins of `0.14.x` only. A project pinned to `0.13.x` is refused by name until it is upgraded, and `listen-fire upgrade` moves its pin once every file checks clean.

One idea runs through the release: **a value that may be one of several things says so, and is read as what it can be.** A record that may be missing is read with `?.`; a record that may be a Memo or a Remark is read for what both have, or narrowed with `is`. 0.13 let such reads check clean and answered nothing, or failed, at run time.

## Contents

- [1. How the pin moves](#1-how-the-pin-moves)
- [2. A field read through a value that may be missing is written `?.`](#2-a-field-read-through-a-value-that-may-be-missing-is-written-)
- [3. A walk off a union lands one of its members' records](#3-a-walk-off-a-union-lands-one-of-its-members-records)
- [4. `lazy` is a closure](#4-lazy-is-a-closure)
- [5. The loop guard slot is removed](#5-the-loop-guard-slot-is-removed)
- [6. Runs paused under 0.13](#6-runs-paused-under-013)
- [7. Affinity: an opportunity list's change `Field` names its columns](#7-affinity-an-opportunity-lists-change-field-names-its-columns)
- [8. For hosts and embedders](#8-for-hosts-and-embedders)
- [9. Diagnostic code index](#9-diagnostic-code-index)

## 1. How the pin moves

- `listen-fire upgrade` checks every movement file of the project as a move up from its pin, and applies the fixes marked safe. `--check` prints the diff and writes nothing.
- The pin (`engine:` in `lf.yaml`) moves to `0.14.0` only when every file then checks clean. Otherwise it stays, and the command lists what is left to change by hand.
- 0.14 changes the meaning of nothing a 0.13 program says. Every change is a refusal, so no warning holds the pin and `--all` adds nothing.
- Until the pin moves, a 0.14 `listen-fire` refuses the project by name, saying to validate it under 0.14.0 and upgrade it.

The order that works:

1. Delete `core.loopGuard` from `lf.yaml` (section 5). Until then every command refuses the project, `upgrade` included.
2. Run `listen-fire upgrade --check` and read what it lists.
3. Replace each `lazy` by hand (section 4).
4. Narrow each read off a union walk that only some of its records have (section 3).
5. Run `listen-fire upgrade`. It writes each `.` through a value that may be missing as `?.` (section 2), and moves the pin when nothing is left.
6. Before running the new engine, let the runs paused holding a `lazy` walk finish, or cancel them (section 6).

## 2. A field read through a value that may be missing is written `?.`

A field is never read with `.` through a value that may be missing, as TypeScript refuses `x.F` under strict null checks where `x` may be undefined. 0.13 refused it through a change's row and a map member; 0.14 refuses it wherever the value comes from.

| Before | After |
| --- | --- |
| `t = only(at-[:Tables]->)`, then `t.Name` | `t?.Name` |
| `only(at-[:Tables]->).Name` | `only(at-[:Tables]->)?.Name` |
| `first(rows).Name`, `rows[0].Name`, `d["a"].Name` | `first(rows)?.Name`, `rows[0]?.Name`, `d["a"]?.Name` |
| `if (t.Name != null) { … }` | `if (t?.Name != null) { … }` |

- A value that may be missing is a record a walk may not find (`only(…)`, `first(…)`, a named `match`), a call's result, an index read, and, as before, a change's row and a map member. Each is refused with `MOV_ABSENT_REQUIRED`.
- `x?.F` reads the field, and is missing when `x` is, so `x?.F == null` holds then. It runs exactly as `x.F` ran in 0.13, so the rewrite is safe and `listen-fire upgrade` applies it.
- A test proves the value present, and the reads after it are written with `.`:
  - `exists(t)`, `t != null`, and `t?.Name != null`;
  - `exists(rows[0])` or `rows[0] != null`, which proves every later `rows[0]`;
  - a map's member is one entry however it is spelled: a test of `d["a"]` proves `d.a`.
- A walk off a record that may be missing is not written `?.`. Walk it inside a test: `if (exists(t)) { t-[:History]-> { … } }`.

```
team = connect `@lf/slack` using team_workspace

function `Post Status`(go: <manual-[:Invocation]->>) {
  ops = only(team-[ch:Channels WHERE ch.Name == "ops"]->)
  if (!exists(ops)) { fail("no #ops channel") }
  write ops-[:Messages]-> { Message: "Status from ${go.Text}: posted to ${ops.Name}" }
}
```

## 3. A walk off a union lands one of its members' records

Where the members of a union land the same edge on different record types (a Person's `Notes` on a Memo, a Company's on a Remark), `crm-[:Subjects]->-[n:Notes]->` lands a Memo or a Remark, as TypeScript's `Memo | Remark`. A read, a walk or a write off it is held to what every one of them has.

| Before | After |
| --- | --- |
| `crm-[:Subjects]->-[n:Notes]-> { … n.Mood … }` | `crm-[:Subjects]->-[n:Notes]-> { if (n is <crm-[:Memo]->>) { … n.Mood … } }` |
| `n.Mood`, then `n.Tone` | `if (n is <crm-[:Memo]->>) { … n.Mood … } else { … n.Tone … }` |

- A field every member's record has (`n.Text`) is read as it was.
- A field only some of them have is refused (`MOV_UNION_MEMBER_ONLY`), naming the `is` test to write. A field none of them has is `MOV_UNKNOWN_PROPERTY`. 0.13 typed nothing past such a hop, so both checked clean and failed at run time.
- `is` narrows the value: inside the arm it is the member named, and in the `else` and every later arm, the rest. Below an arm that always returns or fails, the value is the rest too.
- An `is` naming a type the value can never be is warned (`MOV_IS_NO_OVERLAP`): the arm never runs.
- `listen-fire upgrade` rewrites none of it: only the author knows what a Remark should give where a Memo's `Mood` was read.

## 4. `lazy` is a closure

A closure already says "run this when it is called", so `lazy` is retired. `x = lazy …`, `return lazy …` and a node entry `files: lazy …` are each refused where they are written (`MOV_LAZY_RETIRED`).

| Before | After |
| --- | --- |
| `people = lazy crm-[:People]->`, read as `count(people)` | `people = () => crm-[:People]->`, read as `count(people())` |
| `return lazy crm-[:People]->` | `return crm-[:People]->` |
| a node entry `files: lazy d-[:Files]->` | `files = () => d-[:Files]->` beside the node, called where the files are read; or `files: d-[:Files]->` to keep what the walk lands on when the node is built |

- `listen-fire upgrade` rewrites none of it, and leaves the pin where it is until each is replaced. The refusal names the closure to write.
- Where a lazy name was bound whole to another name, or passed to a function, decide which you meant: the walk's records when the name was bound (pass `people()`), or a walk again at each use (pass the closure, `people`).

## 5. The loop guard slot is removed

- An `lf.yaml` naming `core.loopGuard`, and a core module whose `lf-external.yaml` says `slot: loopGuard`, are refused by name by every command: "the loop guard slot is retired: remove it; the loop breaker (lf.yaml's loopWindow and loopDepth) replaces it".
- Delete `core.loopGuard` from `lf.yaml`, and any guard module from the externals folder. Nothing else changes: 0.13 already ran no guard, and the loop breaker caps every chain of writes and arrivals.

## 6. Runs paused under 0.13

- A paused run's state moves to version 4, which holds no kept walk.
- A run paused under 0.13 while holding a `lazy` walk is refused on resume, by name ("this run paused holding a `lazy` walk"). Let such runs finish, or cancel them, before upgrading the engine.
- Every other run paused under 0.13 resumes.

## 7. Affinity: an opportunity list's change `Field` names its columns

- A listen on `` `List Entry — <opportunity list>` ``'s `Changes` naming a `Field` that is not one of the list's columns is refused (`MOV_ENUM_UNKNOWN_VALUE`), as on every other list. 0.13 typed it as text, so a misspelled column checked clean and never ran.
- Name one of the list's columns, as the refusal lists them. `listen-fire upgrade` rewrites nothing.
- The `@lf/affinity` release that does this needs the 0.14 engine.

## 8. For hosts and embedders

- `triggerEventOf` has left the engine package's `public/inbound`. Build a run's event with `arrivalTriggerOf`.
- The loop guard slot has left `CORE_SLOTS` (`engine-contracts`), and module-kit's `LoopGuard` with it.
- A lowered field read written with `?.` carries `optional: true` (omitted when false). The engine evaluates it as a plain read.
- A paused run's state is version 4 (section 6). The wasm artifacts are rebuilt.
- A host's checker adopts 0.14's refusals (sections 2, 3, 4 and 7) with the 0.14 key, never under a 0.13 pin.

## 9. Diagnostic code index

| Code | Severity under 0.14 | Section |
| --- | --- | --- |
| `MOV_ABSENT_REQUIRED` (a field read through a value that may be missing) | error, safe fix to `?.`, applied by `listen-fire upgrade` | [2](#2-a-field-read-through-a-value-that-may-be-missing-is-written-) |
| `MOV_UNION_MEMBER_ONLY` | error, by hand: narrow the value with `is` | [3](#3-a-walk-off-a-union-lands-one-of-its-members-records) |
| `MOV_UNKNOWN_PROPERTY` (off a union walk's landing) | error, by hand: read a field its records have | [3](#3-a-walk-off-a-union-lands-one-of-its-members-records) |
| `MOV_IS_NO_OVERLAP` | warning: the `is` test is always false | [3](#3-a-walk-off-a-union-lands-one-of-its-members-records) |
| `MOV_LAZY_RETIRED` | error, by hand: write a closure | [4](#4-lazy-is-a-closure) |
| `MOV_ENUM_UNKNOWN_VALUE` (an Affinity opportunity list's `Field`) | error, by hand: name one of the list's columns | [7](#7-affinity-an-opportunity-lists-change-field-names-its-columns) |
