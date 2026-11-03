// The run host's units' chapters (`system:cron`, `system:manual`) are held as
// a module's section is, and harder: each fenced example is a whole program
// the check passes clean, each probe is admitted, and every route the index
// and the catalog text hand out to them resolves.

import { LANGUAGE_VERSION, checkSourceInRust } from 'movement-lang';
import { INTENT_INDEX, readChapter } from '../index';
import { proseViolations } from '../prose_rules';
import { HANDBOOK_CATALOG, admitProbe } from '../testing';
import { UNIT_CHAPTERS } from '../units';
import { FENCE } from './module_manifests';

const chapters = Object.values(UNIT_CHAPTERS);
const examples = chapters.flatMap((c) => [...c.content.matchAll(FENCE)].map((m, i) => [`${c.id} #${i + 1}`, m[1]] as const));
const probes = chapters.flatMap((c) => (c.engineClaims ?? []).map((claim) => [`${c.id}: ${claim.construct}`, claim] as const));

describe('the units’ chapters', () => {
  it('are one per unit, each with an example and a probe', () => {
    expect(Object.keys(UNIT_CHAPTERS).sort()).toEqual(['system:cron', 'system:manual']);
    expect(examples.length).toBe(2);
    expect(probes.length).toBeGreaterThanOrEqual(2);
  });

  it('are what the index routes to under system:cron and system:manual', () => {
    for (const id of ['system:cron', 'system:manual']) {
      expect(INTENT_INDEX.some((e) => e.chapter === id)).toBe(true);
      const read = readChapter(UNIT_CHAPTERS, id);
      expect(read.ok).toBe(true);
    }
  });

  it.each(chapters.map((c) => [c.id, c] as const))('%s holds the prose contract', (_id, chapter) => {
    expect(proseViolations(chapter)).toEqual([]);
  });

  it.each(examples)('%s checks clean', (_name, source) => {
    expect(checkSourceInRust(source, HANDBOOK_CATALOG, { languageVersion: LANGUAGE_VERSION }).map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });

  it.each(probes)('%s is admitted', (_name, claim) => {
    expect(() => admitProbe(claim)).not.toThrow();
  });

  it('say the fields a tick carries', () => {
    const cron = UNIT_CHAPTERS['system:cron'];
    for (const field of ['Fired at', 'Schedule', 'Zone']) expect(cron?.content).toContain(`\`${field}\``);
  });
});
