// One grammar vs the bridge, over every expression text the corpora produce
// (v1, v2 and the current tests — see ../harvest) and a hand-written set for
// what the corpora never write. Plan: plans/functional-extract-2026-10-02/
// 2_one_grammar.md, step 1.
//
// Set DIFF_REPORT=<path> to write every case, both results included, as JSON.
import { CONSTRUCTS, compareAll, compareSynthetic, parseConstructs, type Case, type Outcome } from './differential';

declare function require(id: string): unknown;
declare const process: { env: Record<string, string | undefined> };

/** Corpus texts the two paths treat differently, each with what it means. */
const KNOWN_CORPUS_DISAGREEMENTS = new Map<string, string>([
  [
    'crm-[c:companies WHERE ]->.`__movement_head_probe__`',
    'the formula grammar reads an empty WHERE as no filter; the new grammar refuses it',
  ],
]);

function tally(cases: Case[]): Record<Outcome, number> {
  const counts: Record<Outcome, number> = {
    identical: 0,
    differing: 0,
    'both-reject': 0,
    'new-unparseable': 0,
    'new-refuses': 0,
    'bridge-refuses': 0,
  };
  for (const c of cases) counts[c.outcome]++;
  return counts;
}

describe('one-grammar differential', () => {
  const cases = compareAll();

  if (process.env.DIFF_REPORT) {
    const fs = require('fs') as { writeFileSync(path: string, data: string): void };
    fs.writeFileSync(
      process.env.DIFF_REPORT,
      JSON.stringify({ counts: tally(cases), cases, synthetic: compareSynthetic(), constructs: parseConstructs() }, null, 1),
    );
  }

  it('reads the harvested corpus', () => {
    expect(cases.length).toBeGreaterThan(2000);
  });

  it('lowers every corpus text to exactly what the bridge produces', () => {
    expect(cases.filter(c => c.outcome === 'differing').map(c => c.raw)).toEqual([]);
  });

  it('accepts and refuses the same corpus texts, apart from the known disagreements', () => {
    const disagreeing = cases.filter(
      c => c.outcome !== 'identical' && c.outcome !== 'both-reject' && !KNOWN_CORPUS_DISAGREEMENTS.has(c.raw),
    );
    expect(disagreeing.map(c => `${c.outcome}: ${c.raw}`)).toEqual([]);
  });

  it('refuses with the same diagnostic code where the bridge names one', () => {
    const coded = cases.filter(c => c.outcome === 'both-reject' && !c.bridge.ok && c.bridge.code !== undefined);
    const mismatched = coded.filter(c => c.next.ok || c.next.code !== (c.bridge.ok ? undefined : c.bridge.code));
    expect(mismatched.map(c => c.raw)).toEqual([]);
  });

  it('parses every closure, node and graph literal and node declaration the corpora write', () => {
    const failures = parseConstructs().filter(c => !c.result.ok || c.result.kind !== CONSTRUCTS[c.construct]);
    expect(failures.map(c => `${c.construct}: ${c.result.ok ? c.result.kind : c.result.message}\n${c.raw}`)).toEqual([]);
  });

  describe('hand-written cases the corpora never write', () => {
    it.each(compareSynthetic().map(c => [c.raw, c.mode, c] as const))('%s (%s)', (_raw, _mode, c) => {
      expect(c.outcome).toBe(c.expect);
    });
  });
});
