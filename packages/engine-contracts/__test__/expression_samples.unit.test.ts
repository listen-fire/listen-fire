// Every expression shape the Rust side can write reads through the schema
// whole. The samples are the Rust lowering's own, one per Expression variant
// and nested shape (crates/movement-parser/tests/expression_wire_samples.rs),
// so a variant the schema lacks (or a member it would drop) fails here instead
// of failing the check of a program that uses it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { expressionSchema } from '../expression/expression';
import { listenPlanSchema } from '../listen_plan';

const { samples } = z.object({ samples: z.record(z.string(), z.unknown()) }).parse(JSON.parse(readFileSync(join(__dirname, '../conformance/expression-samples.json'), 'utf8')));

describe('an expression the Rust lowering writes', () => {
  it.each(Object.entries(samples))('%s reads as written', (_name, sample) => {
    expect(expressionSchema.parse(sample)).toEqual(sample);
  });

  it.each(Object.entries(samples))('%s reads as a hop’s filter in a listen plan', (_name, sample) => {
    const hop = { edge: 'E', from: '', to: 'T', judged: 'arrival', taken: sample, checked: sample };
    const plan = { movement: 'f', connection: 'c', adapter: 'a', hops: [hop] };
    expect(listenPlanSchema.parse(plan)).toEqual(plan);
  });
});
