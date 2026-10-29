// The `field` and `becomes` gates against the table of cases listen-fire's Rust is held
// to as well (packages/engine-contracts/conformance/listen-field-change.json).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DiscriminableEvent } from '../../adapter';
import { eventMatchesTriggerScope } from '../listen_config';

interface FieldChangeCase {
  case: string;
  config: Record<string, unknown>;
  event: DiscriminableEvent;
  matches: boolean;
}

// Test data, not a published export: read where the repository keeps it.
const cases: { cases: FieldChangeCase[] } = JSON.parse(
  readFileSync(join(__dirname, '../../../../../engine-contracts/conformance/listen-field-change.json'), 'utf8'),
);

describe("a listen's field and becomes gates", () => {
  it.each(cases.cases)('$case', ({ config, event, matches }) => {
    expect(eventMatchesTriggerScope(event, config)).toBe(matches);
  });
});
