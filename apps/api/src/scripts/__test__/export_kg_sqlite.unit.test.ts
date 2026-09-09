import {
  sanitizeIdentifier,
  dedupeIdentifier,
  valueTypeToSqliteType,
  serializePropertyValue,
  selectKgEndpoint,
} from '../export_kg_sqlite';
import PropertyValueType from '../../generated/kysely/knowledge/PropertyValueType';
import PropertyCardinality from '../../generated/kysely/knowledge/PropertyCardinality';

const KG_ADAPTER_TYPE = 'native-knowledge-graph';

describe('sanitizeIdentifier', () => {
  it('lowercases and snake_cases mixed-case, spaced names', () => {
    expect(sanitizeIdentifier('Portfolio Company')).toBe('portfolio_company');
  });

  it('strips non-alphanumeric characters down to underscores, trimming trailing punctuation', () => {
    expect(sanitizeIdentifier('Round (Series A)!')).toBe('round_series_a');
  });

  it('collapses runs of separators into a single underscore', () => {
    expect(sanitizeIdentifier('Has---Funding   Round')).toBe('has_funding_round');
  });

  it('prefixes with t_ when the sanitized name starts with a digit', () => {
    expect(sanitizeIdentifier('2024 Cohort')).toBe('t_2024_cohort');
  });

  it('suffixes an underscore when the sanitized name is a SQLite keyword', () => {
    expect(sanitizeIdentifier('Order')).toBe('order_');
    expect(sanitizeIdentifier('Table')).toBe('table_');
    expect(sanitizeIdentifier('select')).toBe('select_');
  });

  it('falls back to a placeholder when nothing alphanumeric survives', () => {
    expect(sanitizeIdentifier('!!!')).toBe('t_unnamed');
  });
});

describe('dedupeIdentifier', () => {
  it('returns the candidate unchanged the first time it is seen', () => {
    const used = new Set<string>();
    expect(dedupeIdentifier('company', used)).toBe('company');
  });

  it('suffixes _2, _3, ... on repeated collisions', () => {
    const used = new Set<string>();
    expect(dedupeIdentifier('company', used)).toBe('company');
    expect(dedupeIdentifier('company', used)).toBe('company_2');
    expect(dedupeIdentifier('company', used)).toBe('company_3');
  });

  it('skips a suffix that is already taken by an unrelated prior registration', () => {
    const used = new Set<string>(['company_2']);
    expect(dedupeIdentifier('company', used)).toBe('company');
    expect(dedupeIdentifier('company', used)).toBe('company_3');
  });
});

describe('valueTypeToSqliteType', () => {
  it('maps every property value_type to its SQLite column type', () => {
    expect(valueTypeToSqliteType(PropertyValueType.text)).toBe('TEXT');
    expect(valueTypeToSqliteType(PropertyValueType.number)).toBe('REAL');
    expect(valueTypeToSqliteType(PropertyValueType.boolean)).toBe('INTEGER');
    expect(valueTypeToSqliteType(PropertyValueType.date)).toBe('TEXT');
    expect(valueTypeToSqliteType(PropertyValueType.json)).toBe('TEXT');
  });
});

describe('serializePropertyValue', () => {
  it('returns null when the property row is absent (sparse property model)', () => {
    expect(serializePropertyValue(PropertyValueType.text, PropertyCardinality.single, undefined)).toBeNull();
  });

  it('passes single-cardinality text through as-is', () => {
    const row = {
      value_text: 'hello',
      value_text_array: null,
      value_number: null,
      value_boolean: null,
      value_date: null,
      value_json: null,
    };
    expect(serializePropertyValue(PropertyValueType.text, PropertyCardinality.single, row)).toBe('hello');
  });

  it('serializes multi-cardinality text as a JSON array string', () => {
    const row = {
      value_text: null,
      value_text_array: ['a', 'b', 'c'],
      value_number: null,
      value_boolean: null,
      value_date: null,
      value_json: null,
    };
    expect(serializePropertyValue(PropertyValueType.text, PropertyCardinality.multi, row)).toBe(
      JSON.stringify(['a', 'b', 'c']),
    );
  });

  it('returns null for a multi-cardinality text property with no array set', () => {
    const row = {
      value_text: null,
      value_text_array: null,
      value_number: null,
      value_boolean: null,
      value_date: null,
      value_json: null,
    };
    expect(serializePropertyValue(PropertyValueType.text, PropertyCardinality.multi, row)).toBeNull();
  });

  it('coerces numeric strings (as returned by pg for numeric columns) to JS numbers', () => {
    const row = {
      value_text: null,
      value_text_array: null,
      value_number: '42.5',
      value_boolean: null,
      value_date: null,
      value_json: null,
    };
    expect(serializePropertyValue(PropertyValueType.number, PropertyCardinality.single, row)).toBe(42.5);
  });

  it('maps booleans to 0/1 integers', () => {
    const trueRow = {
      value_text: null,
      value_text_array: null,
      value_number: null,
      value_boolean: true,
      value_date: null,
      value_json: null,
    };
    const falseRow = { ...trueRow, value_boolean: false };
    expect(serializePropertyValue(PropertyValueType.boolean, PropertyCardinality.single, trueRow)).toBe(1);
    expect(serializePropertyValue(PropertyValueType.boolean, PropertyCardinality.single, falseRow)).toBe(0);
  });

  it('serializes dates as ISO 8601 strings', () => {
    const row = {
      value_text: null,
      value_text_array: null,
      value_number: null,
      value_boolean: null,
      value_date: new Date('2026-01-15T12:00:00.000Z'),
      value_json: null,
    };
    expect(serializePropertyValue(PropertyValueType.date, PropertyCardinality.single, row)).toBe(
      '2026-01-15T12:00:00.000Z',
    );
  });

  it('serializes json values as JSON strings', () => {
    const row = {
      value_text: null,
      value_text_array: null,
      value_number: null,
      value_boolean: null,
      value_date: null,
      value_json: { foo: 'bar', n: 1 },
    };
    expect(serializePropertyValue(PropertyValueType.json, PropertyCardinality.single, row)).toBe(
      JSON.stringify({ foo: 'bar', n: 1 }),
    );
  });
});

describe('selectKgEndpoint', () => {
  const kgEndpoint = { adapterType: KG_ADAPTER_TYPE, instanceKey: '|', typeId: 'node-type-1', recordId: 'node-1' };
  const attioEndpoint = { adapterType: 'attio', instanceKey: 'cred-1|', typeId: 'people', recordId: 'attio-rec-1' };

  it('picks the a side as the KG endpoint when a is the KG', () => {
    const result = selectKgEndpoint({ a: kgEndpoint, b: attioEndpoint }, KG_ADAPTER_TYPE);
    expect(result).toEqual({ kind: 'kg', kgEndpoint, otherEndpoint: attioEndpoint });
  });

  it('picks the b side as the KG endpoint when b is the KG', () => {
    const result = selectKgEndpoint({ a: attioEndpoint, b: kgEndpoint }, KG_ADAPTER_TYPE);
    expect(result).toEqual({ kind: 'kg', kgEndpoint, otherEndpoint: attioEndpoint });
  });

  it('flags both-KG bindings rather than picking a side', () => {
    const otherKgEndpoint = { ...kgEndpoint, recordId: 'node-2' };
    const result = selectKgEndpoint({ a: kgEndpoint, b: otherKgEndpoint }, KG_ADAPTER_TYPE);
    expect(result).toEqual({ kind: 'both_kg' });
  });

  it('flags neither-KG bindings rather than fabricating a KG side', () => {
    const otherAttioEndpoint = { ...attioEndpoint, recordId: 'attio-rec-2' };
    const result = selectKgEndpoint({ a: attioEndpoint, b: otherAttioEndpoint }, KG_ADAPTER_TYPE);
    expect(result).toEqual({ kind: 'neither_kg' });
  });
});
