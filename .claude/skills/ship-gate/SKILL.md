---
name: ship-gate
description: Run the batched shippability gate — the workspace typecheck, the cargo tests, the package test sets, the wasm rebuild check, the docs build and the boundary scripts in parallel — and drive fix-up dispatch on failure. Use before pushing or releasing; never during iteration.
---

# Ship gate

The only place expensive verification runs (see CLAUDE.md "Done vs shippable").
Gates everything accumulated on local main since the last gate.

## Procedure

1. Run these in parallel, in the background (independent processes):
   - Typecheck: `NODE_OPTIONS=--max-old-space-size=8192 pnpm -r code:type-check`.
     NEVER `pnpm -r tsc --noEmit` — no package defines a `tsc` script, so it
     matches nothing and exits 0 having checked NOTHING (caught 2026-08-02).
   - The test sets, each through its own `pnpm --filter <package> test`
     (jest and ts-jest are the root install's): `@listen-fire/movement-lang`,
     `@listen-fire/engine`, `@listen-fire/engine-contracts`,
     `@listen-fire/handbook`, `@listen-fire/module-kit`,
     `@listen-fire/fake-channels`, `lf-cli`, and the modules the chunk touched
     (gmail, slack and affinity at least; CI runs those three).
   - `cargo test --locked --workspace` (the crates' own suites and corpora).
   - The wasm rebuild check: `./scripts/build-movement-wasm.sh`, then
     `git status --short packages/movement-lang/wasm` must be empty (the
     `rebuild-matches-committed` job in movement-wasm.yml).
   - `pnpm docs:build`.
   - `node scripts/check-engine-boundary.cjs` and
     `node scripts/check-module-boundary.cjs`: both exit 0.
2. **Green** → report gate-passed; push only if the user has asked for a push,
   and only on the exact commit the gate passed.
3. **Red** → dispatch a fix-up agent (the `implementer` agent) carrying ONLY:
   the verbatim failure output, the suspect files, and the constraint "fix the
   gate failure, change nothing else". Re-run the failed leg (scoped to the
   failing files first, then the full leg).
4. Two failed fix-up rounds → stop and escalate to the user with the evidence.

## Rules

- Never run the gate mid-iteration; batch per shippable chunk.
- Legs run as background tasks — don't block on one before starting the other.
- Report results plainly: what ran, what passed, what failed with verbatim
  output. No hedging.
