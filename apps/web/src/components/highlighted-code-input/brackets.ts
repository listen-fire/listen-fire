// Bracket / function matching for the highlight overlay's caret-driven
// decorations. Pure functions over the raw text + caret offset — no DOM,
// no parser coupling. Brackets inside string / backtick literals are
// ignored so a `"("` in a description never throws balance off.

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);
const isIdentChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);
const isSpace = (ch: string) =>
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

export interface BracketAnalysis {
  /** Bidirectional map: each balanced bracket index → its partner index. */
  pairs: Map<number, number>;
  /** Indices of brackets with no valid partner (unclosed, stray, or
   *  type-mismatched). */
  unbalanced: Set<number>;
}

/** Advance past a quote-delimited run (`"`, `'`, or `` ` ``), honoring
 *  `\`-escapes. Returns the index just past the closing quote. */
function skipQuoted(input: string, start: number): number {
  const quote = input[start];
  let i = start + 1;
  while (i < input.length && input[i] !== quote) {
    if (input[i] === '\\') i++;
    i++;
  }
  return i + 1;
}

export function matchBrackets(input: string): BracketAnalysis {
  const pairs = new Map<number, number>();
  const unbalanced = new Set<number>();
  const stack: { ch: string; idx: number }[] = [];

  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(input, i);
      continue;
    }
    if (ch in OPENERS) {
      stack.push({ ch, idx: i });
    } else if (CLOSERS.has(ch)) {
      const top = stack[stack.length - 1];
      if (top && OPENERS[top.ch] === ch) {
        stack.pop();
        pairs.set(top.idx, i);
        pairs.set(i, top.idx);
      } else {
        unbalanced.add(i);
      }
    }
    i++;
  }
  for (const leftover of stack) unbalanced.add(leftover.idx);
  return { pairs, unbalanced };
}

/** The matching bracket pair for the bracket the caret is adjacent to,
 *  preferring the bracket immediately before the caret. Returns the pair
 *  sorted ascending, or null when the caret touches no balanced bracket. */
export function bracketAtCaret(
  input: string,
  caret: number,
  pairs: Map<number, number>,
): [number, number] | null {
  for (const idx of [caret - 1, caret]) {
    if (idx >= 0 && idx < input.length && pairs.has(idx)) {
      const partner = pairs.get(idx)!;
      return idx < partner ? [idx, partner] : [partner, idx];
    }
  }
  return null;
}

/** When the caret sits on a function name (an identifier immediately
 *  followed by `(`), return the name range and its matched parens, so the
 *  overlay can bold the name + parens (but not the arguments). */
export function functionAtCaret(
  input: string,
  caret: number,
  pairs: Map<number, number>,
): { nameStart: number; nameEnd: number; open: number; close: number } | null {
  let nameStart = caret;
  let nameEnd = caret;
  while (nameStart > 0 && isIdentChar(input[nameStart - 1])) nameStart--;
  while (nameEnd < input.length && isIdentChar(input[nameEnd])) nameEnd++;
  if (nameStart === nameEnd) return null;

  let j = nameEnd;
  while (j < input.length && isSpace(input[j])) j++;
  if (input[j] !== '(') return null;
  const close = pairs.get(j);
  if (close === undefined) return null;
  return { nameStart, nameEnd, open: j, close };
}
