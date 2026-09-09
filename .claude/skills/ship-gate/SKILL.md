---
name: ship-gate
description: Run the batched shippability gate — full monorepo typecheck + the chunk's test set in parallel — and drive fix-up dispatch on failure. Use before pushing or releasing; never during iteration.
---

# Ship gate

The only place expensive verification runs (see CLAUDE.md "Done vs shippable").
Gates everything accumulated on local main since the last gate.

## Procedure

1. Run both, in parallel, in the background (independent processes):
   - Full typecheck: `NODE_OPTIONS=--max-old-space-size=8192 pnpm -r code:type-check`
     (default heap OOMs with exit 134 — that's memory, not a hang).
     NEVER `pnpm -r tsc --noEmit` — no package defines a `tsc` script, so it
     matches nothing and exits 0 having checked NOTHING (caught 2026-08-02).
   - Declaration-emit check (tsc --noEmit misses TS4023/4058, and Render's
     api build emits declarations): in apps/api,
     `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --declaration
     --emitDeclarationOnly --noEmit false --outDir <scratch-dir>`
   - The chunk's test set: `pnpm test:unit --testPathPattern '<dirs touched by
     this chunk>'` — the chunk scope, not the whole suite, unless releasing.
     A wide pattern (2+ big dirs, e.g. `movement|interfaces/rest`) exceeds the
     600s background-command ceiling at ~15-18s/suite — run each big dir as
     its own sequential leg instead (learned twice, 2026-08-03/04).
2. If the chunk touched an integration or agent path, also verify end-to-end
   through the dev loop (boot `pnpm dev:loop:agent`, exercise the real flow,
   check the data roundtrip).
3. **Green** → report gate-passed; push only if the user has asked for a push.
4. **Red** → dispatch a fix-up agent (the `implementer` agent) carrying ONLY:
   the verbatim failure output, the suspect files, and the constraint "fix the
   gate failure, change nothing else". Re-run the failed leg (scoped to the
   failing files first, then the full leg).
5. Two failed fix-up rounds → stop and escalate to the user with the evidence.

## Rules

- Never run the gate mid-iteration; batch per shippable chunk.
- Legs run as background tasks — don't block on one before starting the other.
- Report results plainly: what ran, what passed, what failed with verbatim
  output. No hedging.
