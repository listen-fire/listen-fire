// The deploy check's sweep, over a fake movement store: which pins advance,
// which stay with their diagnostics stored and a Validation Issue emitted,
// which are refused (a preservation failure), and that a second run on the same
// release does nothing.

jest.mock('../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../../lib/kysely', () => ({ getAutomationsQb: jest.fn() }));
jest.mock('../authoring', () => ({
  validateMovementForTeam: jest.fn(),
  assessMovementValidity: jest.fn(),
}));
jest.mock('../firing_context', () => ({ withTeamContext: jest.fn() }));
jest.mock('../store', () => ({
  advanceMovementLanguageVersion: jest.fn(),
  getMovementRow: jest.fn(),
  listAllMovementRows: jest.fn(),
  recordUpgradeCheck: jest.fn(),
  recordValidityOutcome: jest.fn(),
}));
jest.mock('../version_store', () => ({ movementSourceHash: () => 'hash' }));

import type { LanguageRelease, LanguageVersion } from 'movement-lang';

import type { AuthoringDiagnostic } from '../authoring';
import type { MovementRow } from '../store';
import {
  runDeployCheck,
  type DeployCheckDeps,
  type DeployCheckSummary,
} from '../language_upgrade';
import { DEPRECATED_VERSION, RELEASE_APPLIED, VALIDATION_ISSUE } from '../../adapters/system/types';

const RELEASE: LanguageRelease = {
  current: 2,
  supported: new Set([1, 2]),
  deprecated: new Set<LanguageVersion>(),
};

function movement(over: Partial<MovementRow> & { id: string }): MovementRow {
  return {
    teamId: 'team-1',
    name: over.id,
    source: `source of ${over.id}`,
    description: '',
    triggerId: null,
    currentVersionId: null,
    validityStatus: null,
    validityReason: null,
    validitySourceHash: null,
    validityCheckedAt: null,
    validityConsentedAt: null,
    validityCheckedAgainst: null,
    languageVersion: 1,
    upgradeDiagnostics: null,
    upgradeCheckedAgainst: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function diagnostic(severity: AuthoringDiagnostic['severity'], message: string): AuthoringDiagnostic {
  return { code: 'X', message, severity, line: 3, col: 1, endLine: 3, endCol: 2, sourceLine: '' };
}

/** What each movement validates to, under each version. */
type Verdicts = Record<string, Partial<Record<LanguageVersion, AuthoringDiagnostic[]>>>;

/** An in-memory movement store behind the check's seams. */
function fakeStore(input: {
  movements: MovementRow[];
  verdicts: Verdicts;
  release?: LanguageRelease;
}) {
  const pins = new Map(input.movements.map((m) => [m.id, m.languageVersion]));
  const upgradeDiagnostics = new Map<string, AuthoringDiagnostic[]>();
  const validity = new Map<string, LanguageVersion>();
  const events: Array<{ teamId: string; kind: string; reason: string; version: string }> = [];
  const runs: Array<{ tag: string; languageRelease: string; summary: DeployCheckSummary }> = [];

  const deps: DeployCheckDeps = {
    release: { tag: 'v0.8.0', language: input.release ?? RELEASE },
    alreadyRan: async ({ tag, languageRelease }) =>
      runs.some((r) => r.tag === tag && r.languageRelease === languageRelease),
    // Read the pins fresh, as the real store does.
    listMovements: async () =>
      input.movements.map((m) => ({ ...m, languageVersion: pins.get(m.id) ?? m.languageVersion })),
    sourceHash: (source) => `hash:${source}`,
    validate: async ({ movement: m, languageVersion }) => ({
      diagnostics: input.verdicts[m.id]?.[languageVersion] ?? [],
      gaps: [],
    }),
    recordValidity: async ({ movement: m, checkedAgainst }) => {
      validity.set(m.id, checkedAgainst);
    },
    recordUpgradeCheck: async ({ movement: m, diagnostics }) => {
      upgradeDiagnostics.set(m.id, diagnostics);
    },
    advance: async ({ movement: m, to }) => {
      pins.set(m.id, to);
    },
    emit: async ({ teamId, kind, payload }) => {
      events.push({ teamId, kind: kind.typeId, reason: payload.reason, version: payload.version });
    },
    recordRun: async (run) => {
      runs.push(run);
    },
    now: () => new Date('2026-09-29T12:00:00.000Z'),
  };
  return { deps, pins, upgradeDiagnostics, validity, events, runs };
}

describe('the deploy check', () => {
  it('advances a pin that validates cleanly under the current version', async () => {
    const store = fakeStore({ movements: [movement({ id: 'clean' })], verdicts: {} });

    const summary = await runDeployCheck(store.deps);

    expect(store.pins.get('clean')).toBe(2);
    expect(store.validity.get('clean')).toBe(2);
    expect(summary?.automations).toEqual([
      expect.objectContaining({
        name: 'clean',
        outcome: 'advanced',
        from: { version: 1, name: 'Quiet Heron' },
        to: { version: 2, name: 'Bright Otter' },
      }),
    ]);
    expect(store.events.map((e) => e.kind)).toEqual([RELEASE_APPLIED.typeId]);
  });

  it('keeps the pin on a warning under the current version, stores it, and emits a Validation Issue', async () => {
    const warning = diagnostic('warning', 'extracted text is never null under this version');
    const store = fakeStore({
      movements: [movement({ id: 'warns' })],
      verdicts: { warns: { 2: [warning, diagnostic('info', 'just advice')] } },
    });

    const summary = await runDeployCheck(store.deps);

    expect(store.pins.get('warns')).toBe(1);
    // Only what blocks the move is stored — the info is advice.
    expect(store.upgradeDiagnostics.get('warns')).toEqual([warning]);
    expect(summary?.counts).toEqual(
      expect.objectContaining({ advanced: 0, warned: 1, refused: 0 }),
    );
    const issue = store.events.find((e) => e.kind === VALIDATION_ISSUE.typeId);
    expect(issue).toEqual(
      expect.objectContaining({ version: 'Quiet Heron', teamId: 'team-1' }),
    );
    expect(issue?.reason).toContain('line 3: extracted text is never null under this version');
  });

  it('refuses a movement that fails under its own pin: logs, stores, never advances', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'broken' })],
      verdicts: { broken: { 1: [diagnostic('error', 'unknown field')] } },
    });

    const summary = await runDeployCheck(store.deps);

    expect(store.pins.get('broken')).toBe(1);
    expect(store.validity.get('broken')).toBe(1);
    expect(summary?.automations[0]).toEqual(
      expect.objectContaining({ outcome: 'refused', detail: 'line 3: unknown field' }),
    );
    expect(store.events.map((e) => e.kind)).toEqual([VALIDATION_ISSUE.typeId, RELEASE_APPLIED.typeId]);
  });

  it('says so when a refused movement was already failing under its pin before the release', async () => {
    const store = fakeStore({
      movements: [
        movement({
          id: 'was-broken',
          validityStatus: 'invalid',
          validityCheckedAgainst: 1,
          validitySourceHash: 'hash:source of was-broken',
        }),
      ],
      verdicts: { 'was-broken': { 1: [diagnostic('error', 'unknown field')] } },
    });

    const summary = await runDeployCheck(store.deps);

    expect(summary?.automations[0]).toEqual(
      expect.objectContaining({
        outcome: 'refused',
        detail: 'already failing before this release: line 3: unknown field',
      }),
    );
  });

  it('leaves a movement already on the current version alone', async () => {
    const store = fakeStore({ movements: [movement({ id: 'now', languageVersion: 2 })], verdicts: {} });

    const summary = await runDeployCheck(store.deps);

    expect(summary?.automations[0]?.outcome).toBe('current');
    expect(store.upgradeDiagnostics.has('now')).toBe(false);
  });

  it('does nothing the second time on the same release', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'clean' }), movement({ id: 'warns' })],
      verdicts: { warns: { 2: [diagnostic('warning', 'changed meaning')] } },
    });

    expect(await runDeployCheck(store.deps)).not.toBeNull();
    const eventsAfterFirst = store.events.length;

    expect(await runDeployCheck(store.deps)).toBeNull();
    expect(store.runs).toHaveLength(1);
    expect(store.events).toHaveLength(eventsAfterFirst);
  });

  it('emits one Release Applied per workspace, carrying the release and that workspace\'s counts', async () => {
    const store = fakeStore({
      movements: [
        movement({ id: 'a' }),
        movement({ id: 'b', teamId: 'team-2' }),
        movement({ id: 'c', teamId: 'team-2' }),
      ],
      verdicts: { c: { 2: [diagnostic('warning', 'changed meaning')] } },
    });

    await runDeployCheck(store.deps);

    const applied = store.events.filter((e) => e.kind === RELEASE_APPLIED.typeId);
    expect(applied.map((e) => e.teamId)).toEqual(['team-1', 'team-2']);
    expect(applied[1]?.reason).toContain('Release v0.8.0 applied');
    expect(applied[1]?.reason).toContain('Moved to "Bright Otter" (2): 1');
    expect(applied[1]?.reason).toContain('with warnings: 1');
  });

  it('tells a movement left on a deprecated version so', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'old' })],
      verdicts: { old: { 2: [diagnostic('error', 'retired spelling')] } },
      release: { current: 2, supported: new Set([1, 2]), deprecated: new Set([1]) },
    });

    const summary = await runDeployCheck(store.deps);

    expect(store.events.map((e) => e.kind)).toContain(DEPRECATED_VERSION.typeId);
    expect(summary?.automations[0]).toEqual(expect.objectContaining({ outcome: 'warned', deprecated: true }));
  });

  it('marks a movement it could not check unverified and carries on', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'flaky' }), movement({ id: 'clean' })],
      verdicts: {},
    });
    const validate = store.deps.validate;
    store.deps.validate = async (input) => {
      if (input.movement.id === 'flaky') throw new Error('catalog unreachable');
      return validate(input);
    };

    const summary = await runDeployCheck(store.deps);

    expect(summary?.automations.map((a) => [a.name, a.outcome])).toEqual([
      ['flaky', 'unverified'],
      ['clean', 'advanced'],
    ]);
    expect(store.pins.get('flaky')).toBe(1);
  });
});
