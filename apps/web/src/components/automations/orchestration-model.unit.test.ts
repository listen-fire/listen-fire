import {
  buildOrchestration,
  parseOrchestration,
  type OrchStep,
} from '@/components/automations/orchestration-model';

describe('parseOrchestration', () => {
  it('treats null/undefined as empty', () => {
    expect(parseOrchestration(null)).toEqual({ kind: 'empty' });
    expect(parseOrchestration(undefined)).toEqual({ kind: 'empty' });
  });

  it('parses a single run_tg (no then) as linear with one effect', () => {
    expect(parseOrchestration({ kind: 'run_tg', tgId: 'tg-1' })).toEqual({
      kind: 'linear',
      effects: ['tg-1'],
      mode: 'parallel',
    });
  });

  it('parses a flat parallel fan_out as linear', () => {
    expect(
      parseOrchestration({
        kind: 'fan_out',
        mode: 'parallel',
        children: [
          { kind: 'run_tg', tgId: 'tg-1' },
          { kind: 'run_tg', tgId: 'tg-2' },
        ],
      }),
    ).toEqual({ kind: 'linear', effects: ['tg-1', 'tg-2'], mode: 'parallel' });
  });

  it('parses a flat series fan_out as linear', () => {
    expect(
      parseOrchestration({
        kind: 'fan_out',
        mode: 'series',
        children: [
          { kind: 'run_tg', tgId: 'a' },
          { kind: 'run_tg', tgId: 'b' },
          { kind: 'run_tg', tgId: 'c' },
        ],
      }),
    ).toEqual({ kind: 'linear', effects: ['a', 'b', 'c'], mode: 'series' });
  });

  it('parses a run_tg .then chain as a linear chain', () => {
    expect(
      parseOrchestration({
        kind: 'run_tg',
        tgId: 'a',
        then: { kind: 'run_tg', tgId: 'b', then: { kind: 'run_tg', tgId: 'c' } },
      }),
    ).toEqual({ kind: 'linear', effects: ['a', 'b', 'c'], mode: 'chain' });
  });

  it('rejects a .then chain that does not terminate cleanly', () => {
    // The tail is a fan_out, which is richer than the linear chain model.
    expect(
      parseOrchestration({
        kind: 'run_tg',
        tgId: 'a',
        then: { kind: 'fan_out', mode: 'parallel', children: [{ kind: 'run_tg', tgId: 'b' }] },
      }),
    ).toEqual({ kind: 'unsupported' });
  });

  describe('unsupported shapes', () => {
    it('rejects a branch', () => {
      expect(
        parseOrchestration({
          kind: 'branch',
          expr: { op: 'eq' },
          arms: { yes: { kind: 'run_tg', tgId: 'a' } },
          default: { kind: 'run_tg', tgId: 'b' },
        }),
      ).toEqual({ kind: 'unsupported' });
    });

    it('rejects a nested fan_out child', () => {
      expect(
        parseOrchestration({
          kind: 'fan_out',
          mode: 'parallel',
          children: [
            { kind: 'run_tg', tgId: 'a' },
            { kind: 'fan_out', mode: 'series', children: [{ kind: 'run_tg', tgId: 'b' }] },
          ],
        }),
      ).toEqual({ kind: 'unsupported' });
    });

    it('rejects a fan_out whose child run_tg has a then', () => {
      expect(
        parseOrchestration({
          kind: 'fan_out',
          mode: 'parallel',
          children: [{ kind: 'run_tg', tgId: 'a', then: { kind: 'run_tg', tgId: 'b' } }],
        }),
      ).toEqual({ kind: 'unsupported' });
    });

    it('rejects a fan_out with an unknown mode', () => {
      expect(
        parseOrchestration({ kind: 'fan_out', mode: 'whenever', children: [] }),
      ).toEqual({ kind: 'unsupported' });
    });

    it('rejects non-object / unknown-kind input', () => {
      expect(parseOrchestration('nope')).toEqual({ kind: 'unsupported' });
      expect(parseOrchestration({ kind: 'mystery' })).toEqual({ kind: 'unsupported' });
    });
  });
});

describe('buildOrchestration', () => {
  it('returns null for zero effects', () => {
    expect(buildOrchestration([], 'parallel')).toBeNull();
  });

  it('returns a bare run_tg for one effect', () => {
    expect(buildOrchestration(['tg-1'], 'parallel')).toEqual({
      kind: 'run_tg',
      tgId: 'tg-1',
    });
  });

  it('returns a fan_out for two or more effects, preserving mode', () => {
    expect(buildOrchestration(['a', 'b'], 'series')).toEqual({
      kind: 'fan_out',
      mode: 'series',
      children: [
        { kind: 'run_tg', tgId: 'a' },
        { kind: 'run_tg', tgId: 'b' },
      ],
    });
  });
});

describe('round-trip (parse ∘ build) is identity for linear', () => {
  const cases: Array<{ effects: string[]; mode: 'parallel' | 'series' }> = [
    { effects: ['only'], mode: 'parallel' },
    { effects: ['a', 'b'], mode: 'parallel' },
    { effects: ['a', 'b', 'c'], mode: 'series' },
  ];

  for (const { effects, mode } of cases) {
    it(`${mode} [${effects.join(', ')}]`, () => {
      const built = buildOrchestration(effects, mode) as OrchStep;
      const parsed = parseOrchestration(built);
      // A single effect's mode is irrelevant (always reported as parallel),
      // so normalise the expectation the same way the parser does.
      const expectedMode = effects.length === 1 ? 'parallel' : mode;
      expect(parsed).toEqual({ kind: 'linear', effects, mode: expectedMode });
    });
  }
});

describe('parseOrchestration — boolean branches', () => {
  const cond = { type: 'compare', op: 'eq', left: { type: 'property', propertyTypeId: 'x' }, right: { type: 'static', value: 'y' } };

  it('parses a branch (true arm + default) into the branch model', () => {
    expect(
      parseOrchestration({
        kind: 'branch',
        expr: cond,
        arms: { true: { kind: 'run_tg', tgId: 'tg-then' } },
        default: { kind: 'run_tg', tgId: 'tg-else' },
      }),
    ).toEqual({
      kind: 'branch',
      condition: cond,
      then: { effects: ['tg-then'], mode: 'parallel' },
      otherwise: { effects: ['tg-else'], mode: 'parallel' },
    });
  });

  it('parses a branch with no default as an empty otherwise', () => {
    const parsed = parseOrchestration({
      kind: 'branch',
      expr: cond,
      arms: { true: { kind: 'run_tg', tgId: 'tg-then' } },
    });
    expect(parsed).toEqual({
      kind: 'branch',
      condition: cond,
      then: { effects: ['tg-then'], mode: 'parallel' },
      otherwise: { effects: [], mode: 'parallel' },
    });
  });

  it('treats a multi-arm (non-boolean) branch as unsupported', () => {
    expect(
      parseOrchestration({
        kind: 'branch',
        expr: cond,
        arms: { company: { kind: 'run_tg', tgId: 'a' }, person: { kind: 'run_tg', tgId: 'b' } },
      }),
    ).toEqual({ kind: 'unsupported' });
  });

  it('parses a branch whose arm is a .then chain', () => {
    expect(
      parseOrchestration({
        kind: 'branch',
        expr: cond,
        arms: { true: { kind: 'run_tg', tgId: 'a', then: { kind: 'run_tg', tgId: 'b' } } },
      }),
    ).toEqual({
      kind: 'branch',
      condition: cond,
      then: { effects: ['a', 'b'], mode: 'chain' },
      otherwise: { effects: [], mode: 'parallel' },
    });
  });

  it('treats a branch with a genuinely non-linear arm as unsupported', () => {
    expect(
      parseOrchestration({
        kind: 'branch',
        expr: cond,
        arms: {
          true: {
            kind: 'branch',
            expr: cond,
            arms: { true: { kind: 'run_tg', tgId: 'a' } },
          },
        },
      }),
    ).toEqual({ kind: 'unsupported' });
  });
});

describe('buildBranchOrchestration', () => {
  const cond = { type: 'static', value: true };

  it('builds a branch from then + otherwise and round-trips', async () => {
    const { buildBranchOrchestration, parseOrchestration: parse } = await import(
      '@/components/automations/orchestration-model'
    );
    const built = buildBranchOrchestration(
      cond,
      { effects: ['t1', 't2'], mode: 'series' },
      { effects: ['e1'], mode: 'parallel' },
    );
    expect(built).toEqual({
      kind: 'branch',
      expr: cond,
      arms: { true: { kind: 'fan_out', mode: 'series', children: [{ kind: 'run_tg', tgId: 't1' }, { kind: 'run_tg', tgId: 't2' }] } },
      default: { kind: 'run_tg', tgId: 'e1' },
    });
    expect(parse(built)).toEqual({
      kind: 'branch',
      condition: cond,
      then: { effects: ['t1', 't2'], mode: 'series' },
      otherwise: { effects: ['e1'], mode: 'parallel' },
    });
  });

  it('omits the default when otherwise is empty', async () => {
    const { buildBranchOrchestration } = await import('@/components/automations/orchestration-model');
    const built = buildBranchOrchestration(cond, { effects: ['t1'], mode: 'parallel' }, { effects: [], mode: 'parallel' });
    expect(built).toEqual({ kind: 'branch', expr: cond, arms: { true: { kind: 'run_tg', tgId: 't1' } } });
  });

  it('returns null when the then body is empty', async () => {
    const { buildBranchOrchestration } = await import('@/components/automations/orchestration-model');
    expect(
      buildBranchOrchestration(cond, { effects: [], mode: 'parallel' }, { effects: ['e1'], mode: 'parallel' }),
    ).toBeNull();
  });
});
