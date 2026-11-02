// The engine's judge is the source of truth for how a comparison decides
// (crates/movement-engine filter.rs); this unit must decide every case alike.

import { readFileSync } from 'fs';
import { join } from 'path';
import { compareValues, evaluatePredicate } from '../filter';
import type { Expression } from '../types';

describe('a comparison, decided as the engine decides it', () => {
  interface TakenCase {
    case: string;
    filter: Expression;
    fields: Record<string, unknown>;
    holds: boolean;
  }
  // Test data, not a published export: read where the repository keeps it.
  const table: { cases: TakenCase[] } = JSON.parse(readFileSync(join(__dirname, '../../../engine-contracts/conformance/taken-comparisons.json'), 'utf8'));

  it.each(table.cases)('$case', ({ filter, fields, holds }) => {
    expect(evaluatePredicate(filter, { read: (name) => fields[name] })).toBe(holds);
  });
});

describe('WITHIN, measured as the engine measures it', () => {
  const now = Date.UTC(2026, 0, 1);
  const within = (left: unknown, right: unknown) => compareValues(left, 'within', right, { now });

  it('reads ISO texts as instants, a text with no offset as UTC', () => {
    expect(within('2025-12-30', '7d')).toBe(true);
    expect(within('2025-12-20', '7d')).toBe(false);
    expect(within('2025-12-31T23:59:30', '30s')).toBe(true);
    expect(within('2026-01-01T05:00:00+05:00', '1s')).toBe(true);
    expect(within(now - 1_000, 1_000)).toBe(true);
  });

  it('reads no other text as an instant', () => {
    expect(within('Dec 31, 2025', '7d')).toBe(false);
    expect(within('2025-12-31T12:00:00 GMT', '7d')).toBe(false);
    expect(within('2025-02-30', '400d')).toBe(false);
    expect(within('2025-12-31T24:00', '7d')).toBe(false);
  });

  it('reads a boolean as an instant by its number', () => {
    expect(within(true, '1d')).toBe(false);
  });
});
