// An empty identity key is no key — since language version 2. A run pinned to
// version 1 ("Quiet Heron") matches "" like any other value, as v0.6.0 did;
// outside a run (the knowledge pipeline's own matcher) the current version
// holds.

import { withRunCallLedger } from '../../movement_engine/run_scope';
import { candidateIsAllExact, isBlankIdentityValue, type UniquenessConstraints } from '../uniqueness';

const byName: UniquenessConstraints = { any: [{ all: [{ field: 'name' }] }] };

function underVersion<T>(languageVersion: number, fn: () => T): Promise<T> {
  return withRunCallLedger(async () => fn(), { languageVersion });
}

describe('a blank identity key', () => {
  it('is no key in a version-2 run: it never matches, not even another blank', async () => {
    await underVersion(2, () => {
      expect(isBlankIdentityValue('')).toBe(true);
      expect(isBlankIdentityValue('  ')).toBe(true);
      expect(candidateIsAllExact(byName, { name: '' }, { name: '' })).toBe(false);
    });
  });

  it('is a value like any other in a version-1 run: "" matches ""', async () => {
    await underVersion(1, () => {
      expect(isBlankIdentityValue('')).toBe(false);
      expect(isBlankIdentityValue(null)).toBe(true);
      expect(candidateIsAllExact(byName, { name: '' }, { name: '' })).toBe(true);
      expect(candidateIsAllExact(byName, { name: 'Acme' }, { name: '' })).toBe(false);
    });
  });

  it('outside a run, reads as the current version', () => {
    expect(isBlankIdentityValue('')).toBe(true);
  });
});
