import { retentionCutoff } from '../types';

it('cuts off 14 days before now by default', () => {
  const now = new Date('2026-06-15T00:00:00Z');
  expect(retentionCutoff(now).toISOString()).toBe('2026-06-01T00:00:00.000Z');
});
