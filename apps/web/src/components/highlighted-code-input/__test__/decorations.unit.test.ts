import { computeDecorations } from '../decorations';

describe('computeDecorations', () => {
  it('bolds a function name and its parens when caret is on the name', () => {
    const v = 'AI(x)';
    const d = computeDecorations(v, 1); // caret in "AI"
    expect([...d.bold].sort((a, b) => a - b)).toEqual([0, 1, 2, 4]);
  });

  it('marks the matched bracket pair when caret is adjacent to a bracket', () => {
    const v = 'a[b]';
    const d = computeDecorations(v, 2); // just after `[` at 1
    expect([...d.matched].sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('flags unbalanced brackets as errors', () => {
    const v = 'foo(';
    const d = computeDecorations(v, 0);
    expect([...d.error]).toEqual([3]);
  });

  it('produces empty decorations for plain text away from brackets', () => {
    const d = computeDecorations('hello world', 3);
    expect(d.bold.size).toBe(0);
    expect(d.matched.size).toBe(0);
    expect(d.error.size).toBe(0);
  });
});
