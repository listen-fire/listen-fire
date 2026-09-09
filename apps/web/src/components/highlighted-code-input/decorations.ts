// computeDecorations — derive the caret-driven overlay decorations
// (bold function focus, matched bracket pair, unbalanced-bracket errors)
// from the raw value and caret offset. Pure composition of the matchers
// in `./brackets`; the overlay re-runs this on every value/caret change.

import { matchBrackets, bracketAtCaret, functionAtCaret } from './brackets';
import type { Decorations } from './runs';

export function computeDecorations(value: string, caret: number): Decorations {
  const { pairs, unbalanced } = matchBrackets(value);
  const bold = new Set<number>();
  const matched = new Set<number>();
  const error = new Set<number>(unbalanced);

  const fn = functionAtCaret(value, caret, pairs);
  if (fn) {
    for (let i = fn.nameStart; i < fn.nameEnd; i++) bold.add(i);
    bold.add(fn.open);
    bold.add(fn.close);
  }

  const pair = bracketAtCaret(value, caret, pairs);
  if (pair) {
    matched.add(pair[0]);
    matched.add(pair[1]);
  }

  return { bold, matched, error };
}
