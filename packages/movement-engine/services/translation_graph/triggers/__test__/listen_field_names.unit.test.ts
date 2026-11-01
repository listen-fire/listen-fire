// An arrival's records read by the names a program writes, against the table
// of cases listen-fire's Rust is held to as well
// (packages/engine-contracts/conformance/listen-field-names.json).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { namedArrival, namedFields } from '../listen_plans';

interface FieldNamesCase {
  case: string;
  fieldIds: Record<string, string>;
  fields: Record<string, unknown>;
  named: Record<string, unknown>;
}

// Test data, not a published export: read where the repository keeps it.
const cases: { cases: FieldNamesCase[] } = JSON.parse(readFileSync(join(__dirname, '../../../../../engine-contracts/conformance/listen-field-names.json'), 'utf8'));

describe("an arrival's fields, by the names a program reads them by", () => {
  it.each(cases.cases)('$case', ({ fieldIds, fields, named }) => {
    expect(namedFields(fields, fieldIds)).toEqual(named);
  });

  it('reads each record by the record type it states, and leaves one that states none as it came', () => {
    const ids = { Email: { Subject: 'subject' }, Thread: { Topic: 'topic' } };
    const arrival = {
      edge: 'Emails',
      identity: 'm1',
      landing: { recordType: 'Email', fields: { subject: 'Hello' } },
      parents: [{ recordType: 'Thread', fields: { topic: 'Deals' } }, null, { fields: { subject: 'untyped' } }],
    };
    expect(namedArrival(arrival, ids)).toEqual({
      edge: 'Emails',
      identity: 'm1',
      landing: { recordType: 'Email', fields: { subject: 'Hello', Subject: 'Hello' } },
      parents: [{ recordType: 'Thread', fields: { topic: 'Deals', Topic: 'Deals' } }, null, { fields: { subject: 'untyped' } }],
    });
  });
});
