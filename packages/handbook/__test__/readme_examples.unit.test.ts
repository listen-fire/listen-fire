// The README's programs are checked as the handbook's own examples are: against
// the captured schemas of the real modules, by the check a run passes before it
// executes. A README that shows a program the engine refuses is a README that
// lies, and this is the only thing that stops it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CURRENT_LANGUAGE_VERSION, checkSourceInRust } from 'movement-lang';
import { HANDBOOK_CATALOG } from '../testing';

const readme = readFileSync(join(__dirname, '..', '..', '..', 'README.md'), 'utf8');
const programs = [...readme.matchAll(/^```\n(import \{[\s\S]*?)^```$/gm)].map((m) => m[1]);

describe('the programs the README shows', () => {
  it('are there to check', () => {
    expect(programs.length).toBeGreaterThanOrEqual(1);
  });

  it.each(programs.map((source, i) => [i + 1, source]))('program %i checks clean against the captured schemas', (_i, source) => {
    const errors = checkSourceInRust(source, HANDBOOK_CATALOG, { languageVersion: CURRENT_LANGUAGE_VERSION })
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => `${d.code}: ${d.message}`);
    expect(errors).toEqual([]);
  });
});
