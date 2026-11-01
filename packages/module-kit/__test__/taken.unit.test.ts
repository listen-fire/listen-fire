// A taken filter read as comparisons, and each comparison judged as the
// engine judges it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { holds, narrowedTo, takenComparisons } from '../taken';

const field = (name: string) => ({ type: 'property', propertyTypeId: name, fieldOnly: true });
const text = (value: string) => ({ type: 'static', value });

describe('takenComparisons', () => {
  it('reads an AND of comparisons, an IN list and an OR of == on one field, with the field on either side', () => {
    const filter = {
      type: 'logical',
      op: 'and',
      operands: [
        { type: 'compare', op: 'eq', left: field('Query'), right: text('from:acme') },
        { type: 'compare', op: 'in', left: field('Reason'), right: { type: 'list', elements: [text('mention'), text('assign')] } },
        { type: 'logical', op: 'or', operands: [{ type: 'compare', op: 'eq', left: field('Kind'), right: text('a') }, { type: 'compare', op: 'eq', left: text('b'), right: field('Kind') }] },
        { type: 'compare', op: 'gt', left: text('2026-01-01'), right: field('At') },
      ],
    };
    expect(takenComparisons(filter)).toEqual([
      { field: 'Query', op: 'eq', value: 'from:acme' },
      { field: 'Reason', op: 'in', value: ['mention', 'assign'] },
      { field: 'Kind', op: 'in', value: ['a', 'b'] },
      { field: 'At', op: 'lt', value: '2026-01-01' },
    ]);
  });

  it('reads an OR of CONTAINS on one field as containsAny, and an OR mixing operators as nothing it can read', () => {
    const contains = (name: string, value: string) => ({ type: 'compare', op: 'contains', left: field(name), right: text(value) });
    expect(takenComparisons({ type: 'logical', op: 'or', operands: [contains('Labels', 'Deals'), contains('Labels', 'Hiring')] })).toEqual([
      { field: 'Labels', op: 'containsAny', value: ['Deals', 'Hiring'] },
    ]);
    expect(takenComparisons({ type: 'logical', op: 'or', operands: [contains('Labels', 'Deals'), { type: 'compare', op: 'eq', left: field('Labels'), right: text('x') }] })).toBeUndefined();
    expect(takenComparisons({ type: 'logical', op: 'or', operands: [contains('Labels', 'Deals'), contains('Tags', 'x')] })).toBeUndefined();
  });

  it('is none for no filter, and undefined for a part it cannot read', () => {
    expect(takenComparisons(undefined)).toEqual([]);
    expect(takenComparisons({ type: 'compare', op: 'eq', left: field('A'), right: field('B') })).toBeUndefined();
    expect(takenComparisons({ type: 'logical', op: 'or', operands: [{ type: 'compare', op: 'eq', left: field('A'), right: text('x') }, { type: 'compare', op: 'eq', left: field('B'), right: text('y') }] })).toBeUndefined();
  });
});

describe('holds and narrowedTo', () => {
  it('judges as the engine does: CONTAINS is a substring of a text and a member of a list; IN a member of the list', () => {
    expect(holds('Invoice 12', { field: 'Subject', op: 'contains', value: 'Invoice' })).toBe(true);
    expect(holds('invoice 12', { field: 'Subject', op: 'contains', value: 'Invoice' })).toBe(false);
    expect(holds(['INBOX', 'Label_1'], { field: 'Labels', op: 'contains', value: 'Label_1' })).toBe(true);
    expect(holds('mention', { field: 'Reason', op: 'in', value: ['mention', 'assign'] })).toBe(true);
    expect(holds(['mention'], { field: 'Reason', op: 'in', value: ['mention'] })).toBe(false);
    expect(holds('2026-02-01T00:00:00Z', { field: 'At', op: 'gte', value: '2026-01-01' })).toBe(true);
    expect(holds(undefined, { field: 'X', op: 'eq', value: 'a' })).toBe(false);
    expect(holds(['INBOX', 'Label_1'], { field: 'Labels', op: 'containsAny', value: ['Label_9', 'Label_1'] })).toBe(true);
    expect(holds(['INBOX'], { field: 'Labels', op: 'containsAny', value: ['Label_9', 'Label_1'] })).toBe(false);
    expect(holds('Invoice 12', { field: 'Subject', op: 'containsAny', value: ['Receipt', 'Invoice'] })).toBe(true);
  });

  it('names the texts an == or an IN narrows to', () => {
    expect(narrowedTo({ field: 'Reason', op: 'in', value: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(narrowedTo({ field: 'Query', op: 'eq', value: 'from:acme' })).toEqual(['from:acme']);
    expect(narrowedTo({ field: 'Subject', op: 'contains', value: 'x' })).toBeUndefined();
  });
});

// The engine's judge decides the same table (crates/movement-engine
// listen_judge.rs): a module saying `takenApplied` drops nothing it would fire.
describe('a taken filter, applied as the engine judges it', () => {
  interface TakenCase {
    case: string;
    filter: unknown;
    fields: Record<string, unknown>;
    holds: boolean;
    applied: boolean;
  }
  // Test data, not a published export: read where the repository keeps it.
  const table: { cases: TakenCase[] } = JSON.parse(readFileSync(join(__dirname, '../../engine-contracts/conformance/taken-comparisons.json'), 'utf8'));

  it.each(table.cases)('$case', ({ filter, fields, holds: expected, applied }) => {
    const taken = takenComparisons(filter);
    expect(taken !== undefined).toBe(applied);
    if (taken !== undefined) expect(taken.every((comparison) => holds(fields[comparison.field], comparison))).toBe(expected);
  });
});
