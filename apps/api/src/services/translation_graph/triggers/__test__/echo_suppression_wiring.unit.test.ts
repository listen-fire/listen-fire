/**
 * Echo-suppression dispatch-wiring tests (Phase 2).
 *
 * Same source-text idiom as `loop_guard_gate.unit.test.ts`: read the dispatcher
 * source directly (no DB) and pin the load-bearing guarantees so a refactor
 * can't silently drop them:
 *
 *  - the consult sits at the inbound boundary AFTER the loop-guard floor and
 *    BEFORE the engine runs, on BOTH dispatch paths (external + kg-mutation);
 *  - `suppress` returns the `echo_suppressed` disposition and records (not
 *    drops) the stored receipt as suppressed;
 *  - `no-op` (flag on, adapter can't answer) fires as normal with a loud log;
 *  - the consult is skipped under dry-run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const READ = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', rel), 'utf-8');

const routerSrc = READ('services/translation_graph/triggers/router.ts');
const mutationSrc = READ('services/translation_graph/triggers/mutation_dispatch.ts');

describe('dispatchTriggerByIdEvent — echo-suppression wiring (external path)', () => {
  it('consults after the loop guard and before the engine runs', () => {
    const guardIdx = routerSrc.indexOf('applyLoopGuard(');
    const consultIdx = routerSrc.indexOf('consultEchoSuppression({');
    const movementIdx = routerSrc.indexOf('runMovementFiring(');
    expect(consultIdx).toBeGreaterThan(guardIdx);
    // The only execution path is the movement firing (the legacy
    // non-movement orchestration walk retired with the TG engine, kill-tg).
    expect(movementIdx).toBeGreaterThan(consultIdx);
  });

  it('suppression returns echo_suppressed and records the receipt (not drop)', () => {
    expect(routerSrc).toMatch(/disposition\.kind === 'suppress'/);
    expect(routerSrc).toMatch(/markTriggerEventSuppressed\(input\.storedEventId/);
    expect(routerSrc).toMatch(/droppedReason: 'echo_suppressed'/);
  });

  it('a no-op (flag on, unanswerable) is logged and falls through to fire', () => {
    expect(routerSrc).toMatch(/disposition\.kind === 'no-op'/);
    expect(routerSrc).toMatch(/suppress_self on but unanswerable/);
  });

  it('the consult is skipped under dry-run', () => {
    // The consult block opens with the same `if (!dryRun)` guard the floor uses.
    const consultIdx = routerSrc.indexOf('consultEchoSuppression({');
    const preceding = routerSrc.slice(0, consultIdx);
    expect(preceding.lastIndexOf('if (!dryRun)')).toBeGreaterThan(
      preceding.lastIndexOf('// ── OPT-IN ECHO-SUPPRESSION') - 200,
    );
  });
});

describe('dispatchKgMutationTriggers — echo-suppression wiring (kg-mutation path)', () => {
  it('consults after the run_mode gate and before the firing dispatch', () => {
    const gateIdx = mutationSrc.indexOf('runModeGate(trigger.runMode)');
    const consultIdx = mutationSrc.indexOf('consultEchoSuppression({');
    const firingIdx = mutationSrc.indexOf('dispatchMovementMutationFiring({');
    expect(consultIdx).toBeGreaterThan(gateIdx);
    expect(firingIdx).toBeGreaterThan(consultIdx);
  });

  it('asks the trigger’s own adapter from the mutation event provenance and skips on suppress', () => {
    // Resolved from the trigger's kind, not from a named constant: after D25
    // the graph is one adapter among many on this path, and hardcoding it here
    // is the privilege the whole carve removed. The assertion follows.
    expect(mutationSrc).toMatch(/adapterSlug = resolveAdapterSlug\(trigger\.kind\)/);
    expect(mutationSrc).toMatch(/adapterType: adapterSlug/);
    expect(mutationSrc).toMatch(/disposition\.kind === 'suppress'/);
    // No durable receipt on the in-process path — suppression is a `continue`.
    const suppressBranch = mutationSrc.slice(mutationSrc.indexOf("disposition.kind === 'suppress'"));
    expect(suppressBranch.slice(0, 700)).toMatch(/continue;/);
  });

  it('is skipped under dry-run', () => {
    const consultIdx = mutationSrc.indexOf('consultEchoSuppression({');
    const preceding = mutationSrc.slice(0, consultIdx);
    expect(preceding.lastIndexOf('if (!dryRun)')).toBeGreaterThan(-1);
  });
});
