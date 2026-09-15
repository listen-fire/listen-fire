// Entity-resolution arbiter coverage. `arbitrateEntityCandidates` /
// `judgeEntityMatch` (engine/entity_match.ts) decide, on EVERY write that
// returns >1 candidate, whether to merge into an existing record or create a
// new one. A regression here = silent duplicate or wrong-merged records — yet
// the only test reaching this code (movement_engine/run.unit) mocks the LLM
// AND injects fakes that always agree, so the decision logic itself was never
// exercised. This drives every branch by mocking only the LLM `execute` call
// and using the REAL exactness arbitration (`candidateIsAllExact`).

import { execute } from '../../../../lib/prompts/execute';
import type { ExternalRecordRef } from '../../adapter';
import type { UniquenessConstraints } from '../../uniqueness';
import { arbitrateEntityCandidates, judgeEntityMatch, JUDGE_MODEL } from '../entity_match';

// Mock ONLY the LLM call. entity_match imports just `execute` from this module.
jest.mock('../../../../lib/prompts/execute', () => ({
  execute: jest.fn(),
}));

const mockExecute = execute as jest.MockedFunction<typeof execute>;

/** Build a candidate with a flat field bag. */
function ref(data: Record<string, unknown>, externalId = 'rec'): ExternalRecordRef {
  return { adapterType: 'attio', externalId, recordType: 'attio:companies', data };
}

/** Shape the judge returns (validator: {match_index, confidence, reasoning}). */
function judged(match_index: number | null, confidence: number) {
  return { match_index, confidence, reasoning: 'test' } as never;
}

beforeEach(() => {
  mockExecute.mockReset();
});

describe('the judge runs on a Claude model', () => {
  it('names a claude- model, so a deployment with only ANTHROPIC_API_KEY can still judge', () => {
    // Self-hosted deployments document ANTHROPIC_API_KEY only (no OpenAI key).
    // `execute()` only routes to Anthropic when the prompt definition's
    // `model` starts with 'claude-' — anything else silently needs
    // OPENAI_API_KEY and every ambiguous FUZZY write fails closed into a
    // duplicate create.
    expect(JUDGE_MODEL.startsWith('claude-')).toBe(true);
  });
});

describe('judgeEntityMatch — structural short-circuits (no LLM)', () => {
  it('returns null for 0 candidates without calling the LLM', async () => {
    const out = await judgeEntityMatch({ asserted: { name: 'A' }, candidates: [], recordType: 'co' });
    expect(out).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 0 for exactly 1 candidate without calling the LLM', async () => {
    const out = await judgeEntityMatch({
      asserted: { name: 'A' },
      candidates: [ref({ name: 'A' })],
      recordType: 'co',
    });
    expect(out).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('judgeEntityMatch — LLM decision gating', () => {
  const twoCandidates = [ref({ name: 'Acme' }, 'a'), ref({ name: 'Acme Corp' }, 'b')];

  it('returns the matched index when confidence ≥ 0.5', async () => {
    mockExecute.mockResolvedValue(judged(1, 0.9));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: twoCandidates, recordType: 'co' });
    expect(out).toBe(1);
  });

  it('declines (null) when confidence is below 0.5 — the conservative cutoff', async () => {
    mockExecute.mockResolvedValue(judged(1, 0.49));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: twoCandidates, recordType: 'co' });
    expect(out).toBeNull();
  });

  it('returns null when the judge picks no match (match_index null)', async () => {
    mockExecute.mockResolvedValue(judged(null, 0.99));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: twoCandidates, recordType: 'co' });
    expect(out).toBeNull();
  });

  it('returns null when the judge returns an out-of-range index (guards a bad LLM reply)', async () => {
    mockExecute.mockResolvedValue(judged(5, 0.99));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: twoCandidates, recordType: 'co' });
    expect(out).toBeNull();
  });

  it('returns null for a negative index', async () => {
    mockExecute.mockResolvedValue(judged(-1, 0.99));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: twoCandidates, recordType: 'co' });
    expect(out).toBeNull();
  });

  it('declines to merge (null) when the LLM call throws — never errors the write', async () => {
    mockExecute.mockRejectedValue(new Error('anthropic 529'));
    const out = await judgeEntityMatch({ asserted: { name: 'Acme' }, candidates: twoCandidates, recordType: 'co' });
    expect(out).toBeNull();
  });

  it('reports a THROWN judge via onJudgeUnavailable, distinct from a considered decline', async () => {
    mockExecute.mockRejectedValue(new Error('anthropic 529'));
    const onJudgeUnavailable = jest.fn();
    const out = await judgeEntityMatch({
      asserted: { name: 'Acme' },
      candidates: twoCandidates,
      recordType: 'co',
      onJudgeUnavailable,
    });
    expect(out).toBeNull();
    expect(onJudgeUnavailable).toHaveBeenCalledTimes(1);
    expect(onJudgeUnavailable).toHaveBeenCalledWith('anthropic 529');
  });

  it('does NOT call onJudgeUnavailable when the judge answers but declines (low confidence)', async () => {
    mockExecute.mockResolvedValue(judged(1, 0.1));
    const onJudgeUnavailable = jest.fn();
    const out = await judgeEntityMatch({
      asserted: { name: 'Acme' },
      candidates: twoCandidates,
      recordType: 'co',
      onJudgeUnavailable,
    });
    expect(out).toBeNull();
    expect(onJudgeUnavailable).not.toHaveBeenCalled();
  });
});

describe('judgeEntityMatch — prompt construction', () => {
  it('formats the asserted record (skips null/undefined/empty, JSON-encodes objects) and indexes candidates', async () => {
    mockExecute.mockResolvedValue(judged(0, 0.9));
    await judgeEntityMatch({
      asserted: { name: 'Acme', domains: ['acme.com'], blank: '', missing: null, owner: { id: 7 } },
      candidates: [ref({ name: 'Acme' }, 'a'), ref({ name: 'Acme Corp' }, 'b')],
      recordType: 'company',
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const args = mockExecute.mock.calls[0][2] as { recordType: string; asserted: string; candidates: string };
    expect(args.recordType).toBe('company');
    expect(args.asserted).toContain('- name: Acme');
    expect(args.asserted).toContain('- domains: ["acme.com"]');
    expect(args.asserted).toContain('- owner: {"id":7}');
    expect(args.asserted).not.toContain('blank');
    expect(args.asserted).not.toContain('missing');
    expect(args.candidates).toContain('[Candidate 0]');
    expect(args.candidates).toContain('[Candidate 1]');
  });
});

describe('arbitrateEntityCandidates — exactness before the LLM', () => {
  const constraintsOn = (field: string, fuzzy = false): UniquenessConstraints => ({
    any: [{ all: [{ field, ...(fuzzy ? { fuzzy: true } : {}) }] }],
  });

  it('returns null for 0 candidates (create) without the LLM', async () => {
    const out = await arbitrateEntityCandidates({
      asserted: { domain: 'acme.com' },
      candidates: [],
      recordType: 'co',
      constraints: constraintsOn('domain'),
    });
    expect(out).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns 0 for a single candidate without the LLM', async () => {
    const out = await arbitrateEntityCandidates({
      asserted: { domain: 'acme.com' },
      candidates: [ref({ domain: 'acme.com' })],
      recordType: 'co',
      constraints: constraintsOn('domain'),
    });
    expect(out).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('auto-matches the single all-exact candidate WITHOUT calling the LLM', async () => {
    mockExecute.mockRejectedValue(new Error('LLM must not be called'));
    const out = await arbitrateEntityCandidates({
      asserted: { domain: 'acme.com' },
      candidates: [ref({ domain: 'other.com' }, 'a'), ref({ domain: 'acme.com' }, 'b')],
      recordType: 'co',
      constraints: constraintsOn('domain'),
    });
    expect(out).toBe(1);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('falls through to the LLM judge when MORE THAN ONE candidate is all-exact (ambiguous)', async () => {
    mockExecute.mockResolvedValue(judged(0, 0.8));
    const out = await arbitrateEntityCandidates({
      asserted: { domain: 'acme.com' },
      candidates: [ref({ domain: 'acme.com' }, 'a'), ref({ domain: 'acme.com' }, 'b')],
      recordType: 'co',
      constraints: constraintsOn('domain'),
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(out).toBe(0);
  });

  it('falls through to the LLM judge when NO candidate is all-exact', async () => {
    mockExecute.mockResolvedValue(judged(1, 0.7));
    const out = await arbitrateEntityCandidates({
      asserted: { domain: 'acme.com' },
      candidates: [ref({ domain: 'x.com' }, 'a'), ref({ domain: 'y.com' }, 'b')],
      recordType: 'co',
      constraints: constraintsOn('domain'),
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(out).toBe(1);
  });

  it('treats a fuzzy-only constraint branch as never all-exact (always judges)', async () => {
    mockExecute.mockResolvedValue(judged(null, 0.9));
    const out = await arbitrateEntityCandidates({
      asserted: { domain: 'acme.com' },
      candidates: [ref({ domain: 'acme.com' }, 'a'), ref({ domain: 'zzz.com' }, 'b')],
      recordType: 'co',
      constraints: constraintsOn('domain', true),
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(out).toBeNull();
  });

  it('forwards onJudgeUnavailable through to the LLM judge on a throw', async () => {
    mockExecute.mockRejectedValue(new Error('anthropic 529'));
    const onJudgeUnavailable = jest.fn();
    const out = await arbitrateEntityCandidates({
      asserted: { domain: 'acme.com' },
      candidates: [ref({ domain: 'x.com' }, 'a'), ref({ domain: 'y.com' }, 'b')],
      recordType: 'co',
      constraints: constraintsOn('domain'),
      onJudgeUnavailable,
    });
    expect(out).toBeNull();
    expect(onJudgeUnavailable).toHaveBeenCalledWith('anthropic 529');
  });
});
