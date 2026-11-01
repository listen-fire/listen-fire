// The 0.13 migration guide's programs are checked as the README's are: each
// whole program it shows (a fence that opens with its imports) checks clean
// under this release against the captured schemas of the real modules. The
// fragments that show a retired form are not programs, and are not checked.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LANGUAGE_VERSION, checkSourceInRust } from 'movement-lang';
import { HANDBOOK_CATALOG } from '../testing';

const whole = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'language', 'migrating-to-0.13.md'), 'utf8');
// Section 8's listens are checked by `listen-fire check` against the real
// modules they name (apps/cli's upgrade test), most of which this catalog lacks.
const listens = whole.indexOf('## 8. Listens are traversals');
const guide = whole.slice(0, listens) + whole.slice(whole.indexOf('## 9. ', listens));
const programs = [...guide.matchAll(/^```\n(import \{[\s\S]*?)^```$/gm)].map((m) => m[1]);

describe('the programs the 0.13 migration guide shows', () => {
  it('show a replacement for each retired form', () => {
    expect(programs.length).toBeGreaterThanOrEqual(3);
  });

  it.each(programs.map((source, i) => [i + 1, source]))('program %i checks clean under this release', (_i, source) => {
    const errors = checkSourceInRust(source, HANDBOOK_CATALOG, { languageVersion: LANGUAGE_VERSION })
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => `${d.code}: ${d.message}`);
    expect(errors).toEqual([]);
  });
});
