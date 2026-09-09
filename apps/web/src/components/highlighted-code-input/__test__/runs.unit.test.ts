import { assembleRuns, type Decorations } from '../runs';
import { highlightTokens } from '../highlight';

const noDeco = (): Decorations => ({
  bold: new Set(),
  matched: new Set(),
  error: new Set(),
});

describe('assembleRuns', () => {
  it('returns no runs for empty input', () => {
    expect(assembleRuns('', [], noDeco())).toEqual([]);
  });

  it('coalesces a single-class string into one run', () => {
    const v = '"hello"';
    const runs = assembleRuns(v, highlightTokens(v), noDeco());
    expect(runs).toEqual([
      { text: '"hello"', cls: 'string', bold: false, matched: false, error: false },
    ]);
  });

  it('reconstructs the full text across runs', () => {
    const v = 'CONCAT("a")';
    const runs = assembleRuns(v, highlightTokens(v), noDeco());
    expect(runs.map((r) => r.text).join('')).toBe(v);
  });

  it('splits a run where a matched-bracket decoration applies', () => {
    const v = '(x)';
    const deco: Decorations = {
      bold: new Set(),
      matched: new Set([0, 2]),
      error: new Set(),
    };
    const runs = assembleRuns(v, highlightTokens(v), deco);
    // `(` matched, `x` plain not matched, `)` matched
    expect(runs).toEqual([
      { text: '(', cls: 'punctuation', bold: false, matched: true, error: false },
      { text: 'x', cls: 'plain', bold: false, matched: false, error: false },
      { text: ')', cls: 'punctuation', bold: false, matched: true, error: false },
    ]);
  });

  it('marks bold characters (function name + parens)', () => {
    const v = 'AI(x)';
    const deco: Decorations = {
      bold: new Set([0, 1, 2, 4]), // A,I,(,)
      matched: new Set(),
      error: new Set(),
    };
    const runs = assembleRuns(v, highlightTokens(v), deco);
    const boldText = runs.filter((r) => r.bold).map((r) => r.text).join('');
    expect(boldText).toBe('AI()');
    expect(runs.map((r) => r.text).join('')).toBe(v);
  });

  it('marks error (unbalanced bracket) characters', () => {
    const v = '(';
    const deco: Decorations = {
      bold: new Set(),
      matched: new Set(),
      error: new Set([0]),
    };
    const runs = assembleRuns(v, highlightTokens(v), deco);
    expect(runs).toEqual([
      { text: '(', cls: 'punctuation', bold: false, matched: false, error: true },
    ]);
  });
});
