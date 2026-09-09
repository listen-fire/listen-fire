// Lockstep guard: the handbook's engine-status prose vs the engine's own
// gate. Chapters carry machine-readable EngineClaim entries (types.ts)
// for the constructs their prose says run — or don't run yet — on the
// engine. This test runs the movement engine's static interpretability
// scan (services/movement_engine/interpretable.ts — the SAME check
// every save uses) over each claim's probe program:
//
//   - status 'runs'    → the scan must pass the probe clean; if the
//     construct returns to the unsupported list while a chapter still
//     says it works, this fails;
//   - status 'pending' → the scan must flag the probe with the claim's
//     flag; the moment an engine lift stops flagging it, this fails —
//     so closing an engine gap cannot forget the docs.
//
// Probes must parse: a non-parsing probe returns [] from the scan and
// would vacuously satisfy a 'runs' claim, so parseability is asserted
// first.

import { parseProgram } from 'movement-lang';
import { listUnsupportedConstructs } from '../../../../services/movement_engine/interpretable';
import { getMovementHandbook } from '../index';
import type { EngineClaim } from '../types';

const claims: Array<EngineClaim & { chapter: string }> = Object.values(
  getMovementHandbook().chapters,
).flatMap((chapter) =>
  (chapter.engineClaims ?? []).map((claim) => ({ ...claim, chapter: chapter.id })),
);

describe('movement_handbook engine claims — lockstep with interpretable.ts', () => {
  it('chapters declare engine claims (the guard has something to hold)', () => {
    expect(claims.length).toBeGreaterThan(0);
  });

  it('claimed constructs are unique across chapters', () => {
    const constructs = claims.map((c) => c.construct);
    expect(new Set(constructs).size).toBe(constructs.length);
  });

  it.each(claims.map((c) => [c.chapter, c.construct, c] as const))(
    '%s — probe for "%s" parses',
    (_chapter, _construct, claim) => {
      expect(() => parseProgram(claim.probe)).not.toThrow();
    },
  );

  it.each(
    claims
      .filter((c) => c.status === 'runs')
      .map((c) => [c.chapter, c.construct, c] as const),
  )('%s claims "%s" runs — the scan must agree', (_chapter, _construct, claim) => {
    expect(listUnsupportedConstructs(claim.probe)).toEqual([]);
  });

  it.each(
    claims.flatMap((c) =>
      c.status === 'pending' ? [[c.chapter, c.construct, c] as const] : [],
    ),
  )(
    '%s claims "%s" is still pending — the scan must still flag it (a lift here means: update the chapter)',
    (_chapter, _construct, claim) => {
      const found = listUnsupportedConstructs(claim.probe);
      expect(found.some((construct) => construct.includes(claim.flag))).toBe(true);
    },
  );
});
