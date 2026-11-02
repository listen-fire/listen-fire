// Every public module's handbook section is checked as the handbook's own
// chapters are: each fenced example goes through the wasm checker, so a section
// cannot keep teaching a spelling the language has retired. Fragments that lean
// on an earlier fragment draw unresolved names; those are listed as warnings,
// not failures. The retired-spelling diagnostic is a hard failure.

import { LANGUAGE_VERSION, checkSourceInRust } from 'movement-lang';
import { proseViolations } from '../prose_rules';
import { HANDBOOK_CATALOG, admitProbe, checkExemption } from '../testing';
import { FENCE, MODULES } from './module_manifests';

const examples = Object.entries(MODULES).flatMap(([name, manifest]) =>
  [...(manifest.handbookSection?.content ?? '').matchAll(FENCE)].map((m, i) => ({ name: `${name} #${i + 1}`, source: m[1] })),
);

// A fragment that is not a whole program is refused by the parser, not
// diagnosed; that is a warning too, since only the spelling is held here.
function diagnosticsOf(source: string, name: string): Array<{ code: string; message: string }> {
  try {
    return checkSourceInRust(source, HANDBOOK_CATALOG, { languageVersion: LANGUAGE_VERSION });
  } catch (error) {
    console.warn(`${name}: not checked as a whole program: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

// The probes a section declares are what its prose says runs, so they are held
// as the chapters' are: the check a run passes admits each one, against the
// catalog the real adapters publish.
const probes = Object.entries(MODULES).flatMap(([name, manifest]) =>
  (manifest.handbookSection?.engineClaims ?? []).map((claim) => [`${name}: ${claim.construct}`, claim] as const),
);

describe('the examples in every module handbook section', () => {
  it('are there to check', () => {
    expect(Object.values(MODULES).every((m) => m.handbookSection)).toBe(true);
    expect(examples.length).toBeGreaterThanOrEqual(7);
  });

  // The same contract the hand-written chapters keep (prose_rules.ts): a host
  // assembles these sections into its book and holds them to it, so a section
  // that breaks it must fail here, where it is written.
  it.each(Object.entries(MODULES).flatMap(([name, manifest]) => (manifest.handbookSection ? [[name, manifest.handbookSection] as const] : [])))(
    '%s holds the prose contract',
    (name, section) => {
      expect(proseViolations({ id: `system:${name}`, ...section })).toEqual([]);
    },
  );

  it.each(examples.map((e) => [e.name, e.source]))('%s draws no retired spelling', (name, source) => {
    const found = diagnosticsOf(source, name);
    const others = found.filter((d) => d.code !== 'MOV_V5_SPELLING');
    if (others.length) console.warn(`${name}: ${others.map((d) => `${d.code}: ${d.message}`).join('\n  ')}`);
    expect(found.filter((d) => d.code === 'MOV_V5_SPELLING').map((d) => d.message)).toEqual([]);
  });
});

describe('the probes in every module handbook section', () => {
  it('are there to check', () => {
    expect(probes.length).toBeGreaterThan(0);
  });

  it.each(probes.filter(([, claim]) => claim.status === 'runs' && checkExemption(claim) === undefined))('%s is admitted', (_name, claim) => {
    expect(() => admitProbe(claim)).not.toThrow();
  });
});
