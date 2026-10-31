// An arrival a module reports (adapter protocol 2.6) may say when it happened
// at its provider, `occurredAt`: what a host's loop breaker measures from
// whether a run's write caused it.
import { WireArrival } from '../protocol';

const COMPANY = { edge: 'Company', identity: 'company-1', landing: { recordId: 'company-1', recordType: 'Company', fields: { Name: 'Osprey' } } };

describe('an arrival on the wire', () => {
  it('may carry when it happened at its provider', () => {
    expect(WireArrival.parse({ ...COMPANY, occurredAt: '2026-10-31T10:00:00Z' })).toEqual({ ...COMPANY, occurredAt: '2026-10-31T10:00:00Z' });
    expect(WireArrival.parse(COMPANY)).toEqual(COMPANY);
  });

  it('refuses an empty occurredAt', () => {
    expect(WireArrival.safeParse({ ...COMPANY, occurredAt: '' }).success).toBe(false);
  });
});
