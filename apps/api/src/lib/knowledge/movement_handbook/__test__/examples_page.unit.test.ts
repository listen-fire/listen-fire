// The examples handbook's one page: no longer than the lean front page it
// stands in for, held to the prose contract, and every program shown is the
// program checked. The checking itself happens with the chapters'
// (handbook.unit.test.ts and engine_claims.unit.test.ts take
// `examplesPageClaims()` alongside them).

import { EXAMPLE_PROGRAMS, examplesPageClaims, examplesSection, renderExamplesPage } from '../examples_page';
import { renderFrontPage } from '../front_page';
import { proseViolations } from './prose_rules';

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe('the examples page', () => {
  const page = renderExamplesPage();

  // The comparison with the lean handbook is only fair at no greater size.
  it('is no longer than the lean front page, code included', () => {
    expect(words(page)).toBeLessThanOrEqual(words(renderFrontPage()));
  });

  it('holds the prose contract — it may name the tools of the build loop, and nothing else is relaxed', () => {
    const asChapter = { id: 'foundations' as const, title: 'Examples', content: page };
    expect(proseViolations(asChapter, { agentFacing: true })).toEqual([]);
  });

  it('shows each program exactly as it is checked', () => {
    const claims = examplesPageClaims();
    expect(claims).toHaveLength(EXAMPLE_PROGRAMS.length);
    for (const claim of claims) expect(page).toContain(claim.probe.trimEnd());
  });

  it('checks a file import against the file it names', () => {
    const intake = examplesPageClaims().find((c) => c.construct.endsWith('intake'));
    expect(intake?.probe).toContain('from "lib/intake-routines"');
    expect(intake?.status === 'runs' ? Object.keys(intake.files ?? {}) : []).toEqual(['lib/intake-routines']);
  });

  // What the lean front page says in prose, the programs show. A rewrite that
  // drops one of these drops it from the handbook.
  it.each([
    ['comments', '# '],
    ['adapter, credential, plugin and file imports', 'from adapters'],
    ['credentials', 'from credentials'],
    ['plugins', 'from plugins'],
    ['a file import', 'from "lib/'],
    ['construction with credentials', 'attio(credentials:'],
    ['a type in angle brackets', '<inbox-[:Email]->>'],
    ['a write by identity', 'unique by (Name)'],
    ['interpolation', '${msg.From}'],
    ['a graph literal', 'graph<'],
    ['case-insensitive function names', '`log lead`('],
    ['a shape with descriptions', 'node Company: "'],
    ['extract', 'extract(content, Company, {'],
    ['extractOne', 'extractOne('],
    ['MAP with its settings', "{ initialConcurrency: 1, concurrency: 4, onError: 'warn' }"],
    ['a merge', '{ ...c, ...profile }'],
    ['COALESCE', 'COALESCE('],
    ['a conditional write', '?: f.'],
    ['an expression conditional', ' THEN '],
    ['AND', ' AND '],
    ['an early exit on absent', '== null { ERROR('],
    ['an approval', 'asks-[:Check]->'],
    ['await', '= await FIRST('],
    ['a statement branch', '} else {'],
    ['a listener', 'listen to inbox { key: '],
  ])('shows %s', (_what, text) => {
    expect(page).toContain(text);
  });

  it('answers each program alone, and names the real ones for an unknown one', () => {
    for (const program of EXAMPLE_PROGRAMS) {
      const section = examplesSection(program.anchor);
      expect(section.ok).toBe(true);
      if (section.ok) expect(section.content).toContain(program.source);
    }
    expect(examplesSection('build-loop').ok).toBe(true);
    const missing = examplesSection('nope');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('approval');
  });
});
