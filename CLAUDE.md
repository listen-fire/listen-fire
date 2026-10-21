# CLAUDE.md

Working notes for Claude Code in this repository. Personal working style lives
in your user-level `~/.claude/CLAUDE.md`; this file is this repo's specifics.

## Git Workflow

This repo is **trunk-and-worktrees**: commit directly to `main`. Do NOT create
a feature branch before committing routine work — that built-in "branch first on
the default branch" reflex does not apply here. (Isolation, when needed, comes
from git worktrees, not long-lived branches.)

Never amend commits. Always create new commits on top. Pushed commits must never be rewritten.

## Verifying changes

The language has no stack to boot. `lf` is the end-to-end tool: build a project folder, `lf check` it, `lf run` it against the fake modules under `examples/` and `apps/cli/src/__test__/`, and read the run with `lf runs show`. If a change touches a module or a slot, verify it through a test that drives `lf` or the module over its wire. If the tooling can't verify a kind of change, extend the tooling. The hosted platform is `lf-platform`, a separate repository in the same GitHub organisation, with its own dev loop; a language change does not need it.

## Language work (movement-lang)

Changing the parser, checker, or type model? **Read
`packages/movement-lang/CLAUDE.md` first.** It carries the two questions that
have repeatedly turned a feature into a deletion — *"what is the simplest way to
solve this using the structure of the graph?"* and *"what would TypeScript
do?"* — plus the corollaries that keep costing us when ignored (structural not
nominal; a magic string is one that's PARSED rather than compared; silent
degradation is the absence of a guarantee, not a weaker one).

## Language versions (breaking changes never break a saved movement)

Every saved movement is pinned to the language version it was written against (an integer with a two-word name, e.g. 1 "Quiet Heron" = the language as of v0.6.0). The pin governs syntax AND semantics, and every layer honours it:

- A breaking change — a spelling retired, a construct's meaning changed, a plugin's output reshaped, an engine rule tightened — lands as a version conditional (`since(v, n)` / `before(v, n)` on the compile or run context's `languageVersion`) at the point of difference in the parser, checker, engine, plugin or adapter. Never a forked parser, never a second engine.
- The old behaviour is proved by the older version's own test corpus run against the current code under that version. Add a version = add its fixtures; remove a version = delete its conditionals and its fixtures.
- Any construct whose meaning changed gets a checker diagnostic under the new version, so "validates clean under the new version" can never hide a silent behaviour change.
- A release names the versions it supports and deprecates. Unsupported: validate and run refuse, loudly. Deprecated: runs, with a warning.
- The pin moves only by an explicit upgrade; never automatically, and never by an ordinary edit.
- The CHANGELOG entry for a break says which version introduces it and why.

This repository serves language version 5 and later (the supported set is {5}), with no conditional below it: versions 1 to 4, their corpora and their upgrade path are `lf-platform`'s. The first break after 5 lands as version 6 by the rules above.

Plan: `plans/language-versioning-2026-09-29/` (gitignored, on Henry's machine).

## TypeScript & Code Quality

This project uses TypeScript strictly. Before submitting changes:
1. Run `pnpm -r code:type-check` (or the package's `code:type-check`) to verify no type errors
2. Never guess at component props, API parameter shapes, or third-party endpoint/auth details — read the actual type definitions or API docs first
3. Exhaustive branching on enumerable values is checked by the type system (a `never` in the default case)

## Done vs shippable (two-tier verification)

Broad runs do not block the inner loop:

- **Done** (subagent tier): the change should be right — reasoned through, consistent with surrounding code. The ceiling is the scoped test set for the area you touched (`cargo test -p <crate>`, or the package's own `pnpm test` with a path pattern) plus the type-check of the packages you touched.
- **Shippable** (top-level tier, batched): before pushing or releasing, run the ship gate once — `pnpm -r code:type-check`, the cargo tests, the package test sets, `pnpm docs:build` and the boundary scripts, in parallel (independent processes).
- **Gate failure → dispatch a fix-up agent** with just the failure evidence (error output + suspect files), not the builder's history. Bounded retries: two fix-up rounds, then escalate to a maintainer with the evidence.
- Local main may carry done-but-ungated commits; the invariant is **never push ungated**.

**Standing prohibitions**:
- Never build `packages/movement-lang` in place with `tsc`: emitted `.js` files shadow the `.ts` sources and break jest resolution.
- Never wait on a long test run by polling its pid in a shell loop — use `run_in_background` and wait for the completion notification.

## CI philosophy

CI gates the language's own proof: typecheck, the Rust crates' tests, the committed wasm matching a rebuild, the engine package's shim tests, the module and engine import boundaries, and the docs build. Lint and knip are local hygiene, not CI gates.

