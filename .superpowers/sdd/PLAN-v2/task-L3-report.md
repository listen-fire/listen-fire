# Task L3 report: pure calls in a listen's and a wait's filter

**Status:** done. One commit, `5cf4043c9b feat(lang): a filter may call a pure function`, on `claude/pensive-meninsky-bc5d2d` on top of 8c1b6f641f. Signed, not pushed.

## What changed (by concept)

- **The judgeable predicate.** The new rule sits in `crates/movement-checker/src/families/walks.rs`.
  - `is_judgeable_predicate(expr, purity)` has the same shape as `is_pure_predicate`, plus a call. A call qualifies when its callee is pure and each argument is judgeable too.
  - Both now share one walk, `predicate_of`.
  - `is_pure_predicate` is unchanged, and pushdown and event addressing still use it. A call is never taken by a module (test `a_call_is_never_taken_by_the_module`).
  - `purity` is a lookup: `Some(pure)` when the name is a plugin this program imports, `None` otherwise. The brief wrote "catalog". A local name like `t.isMember` resolves only through the program's scope, so a bare catalog cannot answer it.
- **What counts as a pure built-in.** The stdlib already declares effects: `Builtin.effects` in `types/stdlib.rs`, with `now`, `ai` and `reads`. A built-in counts as pure when all three are empty. No new list was made.
  - The refusal says why: "reads the clock", "calls a model", or "reads files".
- **Listen filter.** `foreign_read` in `families/listens/traversal.rs` now checks calls. A call whose callee is pure has its arguments checked recursively. Any other call is refused under `MOV_LISTEN_IMPURE_WHERE`, by name and with the reason. Example: "'t.isGuest' does not declare itself pure, so its answer to the same value could change from one arrival to the next".
  - The old message for non-calls ("'topic' is neither") is unchanged.
- **Wait WHERE.** Both wait sites in `walks.rs` now use the judgeable predicate. An impure call gets a new `MOV_AWAIT_IMPURE_WHERE` message that names the call. The old AI/EXISTS message is kept, because `rules.fixtures.json` pins it.
- **Bind first stays in a run's walks.** The call visitor (`families/calls.rs`) now knows which hops of a head the host judges:
  - every hop of a listen;
  - only the last hop of a wait;
  - no hop of a run's walk.
  - Inside a judged WHERE, a package member call is left to the purity rule. Everywhere else it goes through the existing nested-call check, so a run's walk WHERE gives `MOV_CALL_NESTED`. Before this change that case got a misleading "Unknown name 't'".
- **Typing a plugin call inside an expression.** A new `type_plugin_call` in `plugin_calls.rs` is reached from the typing's function arm. It runs when the typing environment resolves the name to a plugin (`TypeEnv::plugin`, implemented by `ScopeEnv`, which now carries the catalog).
  - Each argument fills the parameter at its place.
  - The L1 brand rules apply unchanged (`MOV_BRAND_REQUIRED`).
  - A value that may be missing, passed where the parameter does not admit absence, is refused with `MOV_ABSENT_REQUIRED` (Review Focus 2).
  - A type misfit is a `MOV_CALL_ARG_TYPE` warning, as for statement calls.
  - Arity problems use the statement call codes: too few is `MOV_THROUGH_ARG_MISSING`, too many is `MOV_THROUGH_BAD_ARG`.
  - The call's type is the plugin's declared output.
- **The plan.** `PlanHop` (in `crates/movement-parser/src/listen_plan.rs`, not movement-engine) gains `asks_host: bool`. It serialises as `asksHost` and is absent when false, so the change is additive.
  - After planning, `plan_host_calls` runs over each hop's checked part:
    - each AND and each OR is stably reordered so terms that ask no host come first, in written order;
    - each plugin call is renamed from its program name to its catalog key (`@lf-platform/team/isMember`).
  - A plan with no host call is unchanged, so its identity is unchanged.
  - The TS contract (`packages/engine-contracts/listen_plan.ts`) gains `asksHost?: boolean` in both the interface and the strict zod schema.
- **Parser, needed for the brief's tests.**
  - **Lowering.** `x.f(args)`, where `x` is no standard namespace, family or capitalised namespace name, now lowers to `Function { fn: "x.f" }` with the letter case kept. This is the dotted name the program imports, as `member_local` builds it.
    - Before, it lowered to `Traverse{alias_root: x, Function{"f" lower-cased}}`. That made `t` an unresolved name and lost the case of `isMember`.
    - Two parser tests pinned the old reading. I updated them in this commit (details under Deviations).
  - **Inside walk brackets.** Every namespaced built-in with an unchanged call shape is now rewritten to its canonical form, as outside the brackets. Before, `Text.regexExtract(...)` inside brackets failed to parse ("TEXT has no function REGEXEXTRACT()"); only the walk words like `Text.lower` worked. The 0.15 row in `language-versions.md` already says built-ins inside brackets are written as outside, so this closes a gap in 0.15.
  - **Missing package import.** `pdf.render(t)` with no import still says which import is missing (`check_dotted_call`). Before, this came from the unresolved root of the old reading.
- **Other.** `filter_split::spell` now spells a function call (`Text.lower(m.Name)`), where it used to print `…`. The CHANGELOG has an Unreleased entry. The wasm was rebuilt and committed.

## TDD evidence

- **Red.** I wrote `crates/movement-checker/tests/pure_calls_in_filters.rs` first.
  - The first run failed to compile, because `PlanHop` had no `asks_host` (E0609).
  - With the field stubbed, it ran 9 tests: 1 passed, 9 failed. The failures included "Unknown name 't'" and `MOV_LISTEN_IMPURE_WHERE` on every pure call, plus the `Text.regexExtract` parse error.
- **Green, as each piece landed.** 3/9, then 7/9, then 8/9, then 9/9, then 10/10 with the pushdown test added.
- **Final scoped signal:**
  - `cargo test -p listen-fire-checker`: 78 suites, 610 passed, 0 failed. This includes the new `pure_calls_in_filters` (10 tests) and `listen_traversal` (26 tests, with a new pure built-in case and a clock case).
  - `cargo test -p listen-fire-parser`: 220 passed, 0 failed.
  - `cargo test -p listen-fire-engine`: 277 passed, 0 failed. I ran it because the lowering and `PlanHop` changed.
  - `corepack pnpm --filter @listen-fire/engine-contracts exec jest __test__/listen_plan.unit.test.ts --maxWorkers=2`: 9 passed.
  - `code:type-check` for engine-contracts: clean.
  - `scripts/build-movement-wasm.sh`: rebuilt, `movement.wasm` sha 1548c066…, `movement_parser.wasm` sha a1985677…, both committed.
- **Not run (left for the ship gate):** the full `pnpm -r code:type-check`, `cargo test -p listen-fire` (the `lf` crate), the movement-lang package tests, and the docs build.

## Deviations from the brief (and why)

1. **"x = Text.lower(t.isMember(e)) gives MOV_CALL_NESTED" is wrong about today's language.** A call inside a value expression in a run's body is hoisted: it is run first and its answer read in its place. That is legal and checks clean. "Bind it first" applies only where an expression is read once per landing (a walk's WHERE, ORDER BY or settings).
   - The test `a_call_outside_a_filter_still_binds_first` asserts `MOV_CALL_NESTED` for a pure plugin in a run's walk WHERE, including a later hop's WHERE and a walk beside a wait.
   - It also asserts that `x = t.isMember(e) == true` still checks clean.
2. **There is no `now()` in the language.** The clock built-in is `Date.today(zone)`, so the tests use that.
3. **There was no plan conjunct type.** Conjuncts are the top-level AND operands of `checked`, which the judge splits. So `asks_host` sits on the hop, and the conjunct order is carried by the order of `checked`'s operands.
4. **The plan names each plugin by its catalog key.** The brief did not ask for this. Without it, L4 cannot form `PluginQuestion.plugin`, because the plan is read without the source and `t.isMember` means nothing there.
   - A guard comes with it: a listen whose plugin's catalog key equals a built-in's name is refused (`MOV_LISTEN_UNWATCHABLE`). The judge must be able to tell a host call from a built-in by name, without parsing.
5. **The wait test waits on an edge** (`await new p-[x:Replies WHERE …]->`). A wait on a root collection runs no purity check at all today, see Risks.
6. **Two parser lowering tests changed.**
   - `Nope.F(x)` and `N.F(x)` used to lower to an alias-rooted traverse; they now lower to the dotted call.
   - `X.READ()` (the shape check for a built-in called off a record) became `TEXT.READ()`.
   - The old record-scoped built-in form (`m.lower(Name)`) is already refused in current spelling, because a bare `Name` inside the brackets is an error. So no current program reads differently.

## Risks and follow-ups for the PM

- **L4 is required before this ships.** The engine's judge has no `Function` arm. A listen whose plan holds a built-in or host call now checks clean, but until L4 every arrival on it is judged undecided. A wait at run time needs the same handling (`awaits.rs`).
- **L4: the order the judge reads a hop.** The judge reads a hop's `checked` part before its `taken` part. Host calls only ever sit in `checked`. When the module did not apply `taken`, the judge should read the local `taken` terms before the host terms in `checked`. Otherwise a failing local term can still cost a round trip.
- **L4: listed hops.** A hop the host resolves by listing (`judged: resolved`) may also carry a host call. The host's listing walk must ask too, or such hops never pass. An alternative is to restrict host calls to hops judged on each arrival. That is a ruling for you.
- **The TS expression schema refuses most function names.** The zod schema in `packages/engine-contracts/expression/expression.ts` allows `function.fn` only from a fixed list (`lower`, `trim`, … `within`). The TS type says `fn: string`. So the TS `listenPlanSchema` refuses a plan whose checked part calls a plugin key or `text.regex_extract`.
  - I did not widen it. Its comment ties it to the platform's persisted translation-graph bodies, which makes it a shared decision.
  - L4 (TS `listenFires`) and F4 must widen it, or give the plan its own schema.
  - My TS test therefore round-trips `asksHost` with a plain compare.
- **Older TS hosts reject plans with host calls.** The plan hop zod schema is strict, so a host built before this change refuses a plan carrying `asksHost`. Only new 0.16 programs with host calls produce one.
- **Bare plugin imports are not admitted in a filter.** `import { is_member as isMember }`, then `isMember(x)` in a filter, is not admitted. Only package members are, which is the design's form.
  - The lowering lower-cases every flat call name, and the parser has no built-in list to tell a plugin from a built-in.
  - Such a call stays `MOV_CALL_NESTED`, and its listen refusal names `'ismember'`.
- **Record answers in a filter are not supported yet.** `team.userFor(x)?.Level` in a filter is untested. The lowering's dotted-call form only applies when nothing follows the call. The typing does give a record output a record type.
- **Built-ins with no declared effect.** `FILE(…)` passes the effects rule. `CHUNKS` with its options map would too, if its arguments are judgeable.
- **Existing gap, untouched.** A wait on a root collection (`await s-[x:Messages WHERE AI(…)]->`) runs no purity check, before and after this change. The listenable check only runs on edge steps.
- **Docs belong to L8.** That includes the handbook and the 0.16 migration row. `docs/contracts/platform-adoption-0.13.md` describes plan fields and does not mention `asksHost`.

## Fix round 1

- **Dotted call off a record.** `check_dotted_call` (`crates/movement-checker/src/families/calls.rs`) no longer exempts a member that is a built-in's name, so `r.lower(...)` with `r` a name in scope gets `MOV_FUNCTION_UNKNOWN` ("no methods"). Package members and standard namespaces never reach it. `x = r.lower(Name)` now carries it too (alongside the bare `Name`'s own `MOV_NAME_UNRESOLVED`).
- **`fail` in a filter.** `impurity_of` (`crates/movement-checker/src/families/walks.rs`) now looks the callee up with `builtin_under` (upper-cased), which knows `ERROR`, and refuses a built-in returning Never: "fails the run, and a filter cannot fail". Before, the lookup missed `ERROR`, so it was refused only as "neither a built-in nor a plugin". Same codes (`MOV_LISTEN_IMPURE_WHERE`, `MOV_AWAIT_IMPURE_WHERE`).
- **CHANGELOG** (Unreleased): the dotted-call refusal under 0.16 and the `fail` refusal.
- **Tests** (`crates/movement-checker/tests/pure_calls_in_filters.rs`): `a_dotted_call_off_a_record_is_refused` (run body, `r.lower(Name)`, run walk WHERE), `fail_is_refused_in_a_filter`, `fail_is_refused_in_a_wait`. Red first: 3 failed, 10 passed. Green after: 13 passed.
- **Commands.** `cargo test -p listen-fire-checker` all ok; `cargo test -p listen-fire-parser` all ok (216 lib); `cargo test -p listen-fire` all ok (565 lib, 8 + others); `scripts/build-movement-wasm.sh` rebuilt, movement.wasm sha b998182f...; committed.
