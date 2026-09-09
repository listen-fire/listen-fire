// The Portfolio → Companies "Raised between" filter compiles to a correlated
// EXISTS over the `event` table, keyed on the company, restricted to
// INVESTMENT_ROUND events whose `date` falls in the requested range. This locks
// the clause's presence/absence and its date bounds at the SQL level, without a
// live database.

jest.mock('../../../../services/context', () => ({
  currentContext: () => ({ user: { teamId: 'team-1' } }),
  unsafeCurrentContext: () => undefined,
}));

import { getBaseQuery } from '../investments';

type RaisedInput = {
  raisedFrom?: string | null;
  raisedTo?: string | null;
};

function compile(raised: RaisedInput) {
  const input = {
    filter: { ...raised },
    config: {},
  } as Parameters<typeof getBaseQuery>[0]['input'];
  return getBaseQuery({ input }).selectAll().compile();
}

describe('getBaseQuery — "Raised between" filter', () => {
  it('omits the round-existence clause when neither bound is set', () => {
    const { sql } = compile({});
    expect(sql).not.toContain('as "round"');
  });

  it('adds a correlated INVESTMENT_ROUND EXISTS when a bound is set', () => {
    const { sql, parameters } = compile({ raisedFrom: '2024-01-01' });
    expect(sql).toContain('"event" as "round"');
    expect(sql).toContain('exists');
    expect(parameters).toContain('INVESTMENT_ROUND');
  });

  it('applies a lower bound for raisedFrom', () => {
    const { sql, parameters } = compile({ raisedFrom: '2024-01-01' });
    expect(sql).toContain('"round"."date" >=');
    expect(parameters).toContainEqual(new Date('2024-01-01'));
  });

  it('applies an upper bound for raisedTo', () => {
    const { sql, parameters } = compile({ raisedTo: '2024-12-31' });
    expect(sql).toContain('"round"."date" <=');
    expect(parameters).toContainEqual(new Date('2024-12-31'));
  });

  it('applies both bounds together', () => {
    const { sql } = compile({ raisedFrom: '2024-01-01', raisedTo: '2024-12-31' });
    expect(sql).toContain('"round"."date" >=');
    expect(sql).toContain('"round"."date" <=');
  });
});
