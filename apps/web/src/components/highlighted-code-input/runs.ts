// Run assembly — merge per-token color classes with per-character caret
// decorations (matched-bracket, bold function focus, unbalanced-bracket
// error) into the minimal list of styled runs the overlay renders. Pure
// and character-exact: the concatenated run text always equals the input,
// so the overlay aligns to the textarea glyph-for-glyph.

import type { HighlightSpan, HighlightClass } from './highlight';

export interface Decorations {
  bold: Set<number>;
  matched: Set<number>;
  error: Set<number>;
}

export interface Run {
  text: string;
  cls: HighlightClass;
  bold: boolean;
  matched: boolean;
  error: boolean;
}

export function assembleRuns(
  value: string,
  spans: HighlightSpan[],
  deco: Decorations,
): Run[] {
  if (value.length === 0) return [];

  // Per-character color class (default 'plain' for any uncovered gap).
  const classAt: HighlightClass[] = new Array(value.length).fill('plain');
  for (const s of spans) {
    for (let i = s.start; i < s.end; i++) classAt[i] = s.cls;
  }

  const runs: Run[] = [];
  for (let i = 0; i < value.length; i++) {
    const cls = classAt[i];
    const bold = deco.bold.has(i);
    const matched = deco.matched.has(i);
    const error = deco.error.has(i);
    const last = runs[runs.length - 1];
    if (
      last &&
      last.cls === cls &&
      last.bold === bold &&
      last.matched === matched &&
      last.error === error
    ) {
      last.text += value[i];
    } else {
      runs.push({ text: value[i], cls, bold, matched, error });
    }
  }
  return runs;
}
