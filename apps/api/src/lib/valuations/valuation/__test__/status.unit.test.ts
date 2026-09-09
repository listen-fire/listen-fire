// deriveInvestmentStatus is the single source of truth behind the portfolio
// CSV export's Status column and the company page's status badge — both must
// read the same "is anything left to come?" input through this function rather
// than re-deriving their own notion of exited-ness.

import { deriveInvestmentStatus } from '../status';

describe('deriveInvestmentStatus', () => {
  it('is "active" while we still hold anything the investment turned into', () => {
    expect(deriveInvestmentStatus(true)).toBe('active');
  });

  it('is "realised" once nothing is left held', () => {
    expect(deriveInvestmentStatus(false)).toBe('realised');
  });
});
