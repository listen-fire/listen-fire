// The landing check against the table of cases listen-fire's Rust is held to
// as well (packages/engine-contracts/conformance/listen-landings.json): each
// arrival's landing, checked against the node its listen states, names the
// case's misfits, whether the node is read from the source on each check or
// read once.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { landingMisfits, landingNode } from '../listen_plans';

// Test data, not a published export: read where the repository keeps it.
const table = z
  .object({
    about: z.string(),
    sources: z.record(z.string(), z.string()),
    cases: z
      .array(z.object({ case: z.string(), source: z.string(), node: z.string(), landing: z.unknown(), named: z.string(), misfits: z.array(z.string()) }).strict())
      .min(1),
  })
  .strict()
  .parse(JSON.parse(readFileSync(join(__dirname, '../../../../../engine-contracts/conformance/listen-landings.json'), 'utf8')));

describe('whether what landed fits the node a listen states it is', () => {
  it.each(table.cases)('$case', ({ source, node, landing, named, misfits }) => {
    const text = table.sources[source];
    if (text === undefined) throw new Error(`no source '${source}' in the table`);
    expect(landingMisfits({ source: text, node, landing })).toEqual({ node: named, misfits });
    expect(landingMisfits({ ...landingNode({ source: text, node }), landing })).toEqual({ node: named, misfits });
  });

  it('refuses a source that declares no such node', () => {
    expect(() => landingMisfits({ source: 'node Charge {\n  id: <text>\n}\n', node: 'Payment', landing: {} })).toThrow(/the source declares no node Payment/);
    expect(() => landingNode({ source: 'node Charge {\n  id: <text>\n}\n', node: 'Payment' })).toThrow(/the source declares no node Payment/);
  });
});
