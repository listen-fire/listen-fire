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

The language version is the toolchain release: the one semver every crate and package carries (`0.12.0`). A saved movement is pinned to the release it was written against; there is no separate integer and no name. The pin governs syntax AND semantics, and every layer honours it through one rule, `compatible(pin, own)` (`crates/movement-parser/src/version.rs` and `packages/movement-lang/language_version.ts`, pinned to `docs/contracts/language-versions.md`):

- A release reads a pin with its own compatibility key (the minor under 0.x, the major from 1.0) and refuses any other by name, with the remedy: a newer pin says to upgrade the engine; an older key says to validate under this release and upgrade.
- A breaking change — a spelling retired, a construct's meaning changed, a plugin's output reshaped, an engine rule tightened — ships in a release of a new compatibility key, never within one. Never a forked parser, never a second engine in this repository.
- Any construct whose meaning changed gets a checker diagnostic under the new key, so "validates clean under the new release" can never hide a silent behaviour change.
- A deprecation is the CHANGELOG's to announce: a compatible pin runs as written.
- The pin moves only by an explicit upgrade; never automatically, and never by an ordinary edit.
- The CHANGELOG entry for a break says which release introduces it and why.

Diagnostic codes keep their names across releases (agents and tests key on them); only their texts change. Earlier integer-pinned movements, their corpora and their upgrade path are `lf-platform`'s.

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
- A worktree symlinks its `target` to the main checkout's target directory (never grows its own) and sets `CARGO_INCREMENTAL=0`; gates build the default and the cli-only feature sets only; `cargo clean` of stale artifacts is fine after a gate. An `LF_BIN` copy for a gate lives beside the original (`target/debug/lf-gate`): a workspace-built `lf` finds the bundled `@lf/*` modules by walking up from its own path to the repository, so a copy outside it cannot find them.

## CI philosophy

CI gates the language's own proof: typecheck, the Rust crates' tests, the committed wasm matching a rebuild, the engine package's shim tests, the module and engine import boundaries, and the docs build. Lint and knip are local hygiene, not CI gates.

