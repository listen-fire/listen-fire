// An empty identity key is no key, at every pin. The language before 0.7
// once matched "" like any other value; that branch is retired (ruling 20 of
// the repo split), so any pin decides it the same way.

import { LANGUAGE_VERSION } from 'movement-lang';

import { candidateIsAllExact, isBlankIdentityValue, type UniquenessConstraints } from 'engine-contracts/uniqueness';

const byName: UniquenessConstraints = { any: [{ all: [{ field: 'name' }] }] };

const exact = (languageVersion: string, asserted: string, candidate: string) =>
  candidateIsAllExact(byName, { asserted: { name: asserted }, candidate: { name: candidate }, languageVersion });

describe('a blank identity key', () => {
  it('is no key: it never matches, not even another blank', () => {
    expect(isBlankIdentityValue('', LANGUAGE_VERSION)).toBe(true);
    expect(isBlankIdentityValue('  ', LANGUAGE_VERSION)).toBe(true);
    expect(isBlankIdentityValue(null, LANGUAGE_VERSION)).toBe(true);
    expect(exact(LANGUAGE_VERSION, '', '')).toBe(false);
    expect(exact(LANGUAGE_VERSION, 'Acme', '')).toBe(false);
  });

  it('is no key under an older pin too: the old branch is retired', () => {
    expect(isBlankIdentityValue('', '0.6.0')).toBe(true);
    expect(exact('0.6.0', '', '')).toBe(false);
  });
});
