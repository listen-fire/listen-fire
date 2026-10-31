// The listen judge against the table of cases listen-fire's Rust is held to
// as well (packages/engine-contracts/conformance/listen-arrivals.json): each
// plan is what the check answers for its listen, and each arrival gets the
// case's verdict.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { listenArrivalCasesSchema } from 'engine-contracts/conformance';
import { z } from 'zod';

import { checkAnswerInRust } from '../../../movement_engine/program_check';
import { judgeArrival, listenPlansOf } from '../listen_plans';

// Test data, not a published export: read where the repository keeps it.
const text = readFileSync(join(__dirname, '../../../../../engine-contracts/conformance/listen-arrivals.json'), 'utf8');
const table = listenArrivalCasesSchema.parse(JSON.parse(text));
// The plans as the file writes them, so a member the schemas drop shows.
const written = z.object({ plans: z.record(z.string(), z.object({ source: z.string(), plan: z.unknown() })) }).parse(JSON.parse(text));

describe('the plans a check answers for its listens', () => {
  it.each(Object.entries(written.plans))('%s is the checker’s plan for its listen', (_name, { source, plan }) => {
    expect(listenPlansOf(checkAnswerInRust({ source, catalog: table.catalog }))).toEqual([plan]);
  });

  it('are none when the answer carries none', () => {
    expect(listenPlansOf({ diagnostics: [], stamps: [] })).toEqual([]);
    expect(listenPlansOf(undefined)).toEqual([]);
  });

  it('refuses a plan that is not one', () => {
    expect(() => listenPlansOf({ listens: [{ movement: 'f' }] })).toThrow();
  });
});

describe('whether an arrival fires a listen', () => {
  it.each(table.cases)('$case', ({ plan, arrival, now, verdict }) => {
    const entry = table.plans[plan];
    if (entry === undefined) throw new Error(`no plan '${plan}' in the table`);
    expect(judgeArrival(entry.plan, arrival, Date.parse(now))).toEqual(verdict);
  });
});
