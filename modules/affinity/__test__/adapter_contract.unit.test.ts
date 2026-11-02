// A module's class is an `Adapter`: its event subscription methods take the
// edge inputs adapter protocol 2.6 defines, so the contract must accept them.
// The check is the compiler's (`pnpm code:type-check`); jest only loads it.

import type { Adapter } from 'engine-contracts';

import type { AffinityAdapter } from '../index';

type Assert<T extends true> = T;
export type AffinityAdapterIsAnAdapter = Assert<AffinityAdapter extends Adapter ? true : false>;

it('is checked by the compiler', () => {
  expect(true).toBe(true);
});
