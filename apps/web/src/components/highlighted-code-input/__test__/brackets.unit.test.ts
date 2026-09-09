import { matchBrackets, bracketAtCaret, functionAtCaret } from '../brackets';

describe('matchBrackets', () => {
  it('pairs a simple ()', () => {
    const { pairs, unbalanced } = matchBrackets('()');
    expect(unbalanced.size).toBe(0);
    expect(pairs.get(0)).toBe(1);
    expect(pairs.get(1)).toBe(0);
  });

  it('pairs nested brackets of mixed kinds', () => {
    const { pairs, unbalanced } = matchBrackets('([{}])');
    expect(unbalanced.size).toBe(0);
    expect(pairs.get(0)).toBe(5);
    expect(pairs.get(1)).toBe(4);
    expect(pairs.get(2)).toBe(3);
  });

  it('flags an unclosed opener', () => {
    const { pairs, unbalanced } = matchBrackets('(');
    expect(pairs.size).toBe(0);
    expect([...unbalanced]).toEqual([0]);
  });

  it('flags a stray closer', () => {
    const { unbalanced } = matchBrackets(')');
    expect([...unbalanced]).toEqual([0]);
  });

  it('flags a mismatched pair as unbalanced', () => {
    const { unbalanced } = matchBrackets('(]');
    expect(unbalanced.has(0)).toBe(true);
    expect(unbalanced.has(1)).toBe(true);
  });

  it('ignores brackets inside string literals', () => {
    const { pairs, unbalanced } = matchBrackets('"( ["');
    expect(pairs.size).toBe(0);
    expect(unbalanced.size).toBe(0);
  });

  it('ignores brackets inside backtick property names', () => {
    const { unbalanced } = matchBrackets('`a (b) c`');
    expect(unbalanced.size).toBe(0);
  });

  it('pairs the brackets of a traversal step', () => {
    // -[:E]->  → `[` at 1 matches `]` at 4
    const { pairs } = matchBrackets('-[:E]->');
    expect(pairs.get(1)).toBe(4);
    expect(pairs.get(4)).toBe(1);
  });
});

describe('bracketAtCaret', () => {
  const input = '([])';
  const { pairs } = matchBrackets(input);

  it('matches the bracket the caret sits just after', () => {
    // caret index 1 is just after `(` at 0
    expect(bracketAtCaret(input, 1, pairs)).toEqual([0, 3]);
  });

  it('matches the bracket the caret sits just before', () => {
    // caret index 0 is just before `(` at 0
    expect(bracketAtCaret(input, 0, pairs)).toEqual([0, 3]);
  });

  it('prefers the bracket before the caret when both sides are brackets', () => {
    // input `([])`, caret at 2 → before is `[`(1), after is `]`(2).
    // Prefer the one just before the caret.
    expect(bracketAtCaret(input, 2, pairs)).toEqual([1, 2]);
  });

  it('returns null when the caret is not adjacent to a bracket', () => {
    expect(bracketAtCaret('a + b', 3, new Map())).toBeNull();
  });
});

describe('functionAtCaret', () => {
  it('returns the name range and matched parens when caret is on a function name', () => {
    const input = 'CONCAT("a", "b")';
    const { pairs } = matchBrackets(input);
    // caret at 3 sits inside `CONCAT`
    expect(functionAtCaret(input, 3, pairs)).toEqual({
      nameStart: 0,
      nameEnd: 6,
      open: 6,
      close: 15,
    });
  });

  it('works when the caret is at the end of the function name', () => {
    const input = 'AI(x)';
    const { pairs } = matchBrackets(input);
    expect(functionAtCaret(input, 2, pairs)).toEqual({
      nameStart: 0,
      nameEnd: 2,
      open: 2,
      close: 4,
    });
  });

  it('returns null for an identifier that is not a function call', () => {
    expect(functionAtCaret('Subject', 3, new Map())).toBeNull();
  });

  it('returns null when caret is in the arguments, not the name', () => {
    const input = 'CONCAT(x)';
    const { pairs } = matchBrackets(input);
    expect(functionAtCaret(input, 8, pairs)).toBeNull();
  });
});
