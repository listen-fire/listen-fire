# Contributing to Listen-Fire (the language)

This is the language repository: the Rust crates, the `lf` command, the engine package, the modules and the documentation site. The hosted platform is `lf-platform`, a separate repository in the same GitHub organisation, which installs this repository's published packages. This repository serves the language of its own release.

## Setting up

You need Node 22.20.0 (the version pinned in [`.nvmrc`](.nvmrc)), pnpm 9.5 or later (the root `package.json` pins `pnpm@9.5.0` as its `packageManager` and declares `"pnpm": "^9.5.0"` in `engines`), and Rust 1.99.0 with the `wasm32-unknown-unknown` target (pinned in [`rust-toolchain.toml`](rust-toolchain.toml)).

```bash
nvm install && nvm use          # reads .nvmrc
npm install -g pnpm
pnpm install
```

Install the whole workspace, not a filtered subset. Packages are consumed as raw TypeScript through symlinks, so a filtered install drops the symlinks and the typecheck fails with unresolved-module errors. No database, Docker or `.env` is needed.

## Typecheck

```bash
pnpm -r code:type-check
```

This is what CI runs, and it is the gate that matters most before opening a pull request.

## Tests

Run tests scoped to what you changed.

```bash
cargo test --locked -p listen-fire-parser -p listen-fire-checker -p listen-fire-engine -p listen-fire
cd packages/movement-lang && pnpm test
```

The Rust crates are the language; the TypeScript packages are the host surface around the wasm artifact. `scripts/build-movement-wasm.sh` regenerates the committed wasm artifacts; CI fails if the committed bytes differ from a rebuild. [`packages/movement-lang/CLAUDE.md`](packages/movement-lang/CLAUDE.md) has the detail on the language's suites.

`pnpm docs:build` builds the documentation site and checks its links.

## Working on the language

The parser, checker and type model live in [`packages/movement-lang`](packages/movement-lang). Read [`packages/movement-lang/CLAUDE.md`](packages/movement-lang/CLAUDE.md) before changing any of them. It carries the two questions that have repeatedly turned a proposed feature into a deletion: "what is the simplest way to solve this using the structure of the graph?" and "what would TypeScript do?": along with the invariants that keep costing time when they are ignored: the type system is structural rather than nominal, a magic string is one that gets parsed rather than compared, and silent degradation is the absence of a guarantee rather than a weaker one.

## Commits

Commit subjects follow conventional-commit style: a type, an optional scope in parentheses, a colon, then a lower-case statement of what the change does. Recent examples from `git log`:

```
fix(movement-lang): the published wasm artifacts resolve by subpath
feat(engine): the engine's own tests come home; adapter-support gains currentLanguageVersion
fix(scripts): the module boundary check runs in a tree without the kit's sources
test(engine): the seam guard's engine cases live with the engine
```

Write the subject as a fact about the resulting code, not as an instruction. Comments in the code explain *why*, never *what*.

A pull request that changes what an author writes, or what an `lf` user sees, adds a line under Unreleased in [`CHANGELOG.md`](CHANGELOG.md), in the same pull request. This repository's Unreleased section takes only its own entries.

## Claude Code

The maintainers develop this repository with Claude Code. [`CLAUDE.md`](CLAUDE.md) at the root is the instruction file it reads, and [`.claude/skills`](.claude/skills) holds the repo's packaged procedures: currently the batched pre-push gate. Both are checked in, so a contributor using Claude Code gets the same workflow the maintainers do; neither is required if you are not using it.
