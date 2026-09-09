// Control-tower observability — the pure derivations behind the read queries
// (§5.6). The DB shape of listParkedRuns / listTeamRuns is exercised through the
// dev loop; here we pin the address-prefix fan-out math (countPendingJoinGroups).

import { countPendingJoinGroups } from '../observability';

describe('countPendingJoinGroups', () => {
  it('counts a fan-out with multiple pending siblings as one group', () => {
    // A fan-out over 3 items, all still parked: one enclosing-join group with 3.
    const addresses = ['s1.i0.s0', 's1.i1.s0', 's1.i2.s0'];
    expect(countPendingJoinGroups(addresses)).toBe(1);
  });

  it('ignores standalone asks (no enclosing join)', () => {
    expect(countPendingJoinGroups(['s0', 's1'])).toBe(0);
  });

  it('ignores a group with only one pending sibling left', () => {
    // Only iter0 still parked under the fan-out — not "multiple siblings".
    expect(countPendingJoinGroups(['s1.i0.s0'])).toBe(0);
  });

  it('counts two distinct fan-out groups separately', () => {
    const addresses = [
      's1.i0.s0.b0.s0',
      's1.i0.s0.b1.s0', // inner parallel of item 0 (group A: 2)
      's3.i0.s0',
      's3.i1.s0', // a separate fan-out (group B: 2)
    ];
    expect(countPendingJoinGroups(addresses)).toBe(2);
  });
});
