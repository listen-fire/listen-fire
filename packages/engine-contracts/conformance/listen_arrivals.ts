// The cases every host's listen judge is held to (listen-arrivals.json beside
// this file): listen-fire's Rust, the engine's TypeScript and the hosted
// product each read them. Each plan is the checker's answer for its listen's
// source against the file's catalog, and each case an arrival on one plan, the
// instant WITHIN measures from, and the verdict.

import { z } from 'zod';

import type { CatalogSnapshot } from 'movement-lang';

import { listenPlanSchema, planArrivalSchema, verdictSchema } from '../listen_plan';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A catalog snapshot at its top level; the checker reads the rest. */
const catalogSnapshotSchema = z.custom<CatalogSnapshot>(
  (value) => isRecord(value) && isRecord(value.adapters) && isRecord(value.credentials) && isRecord(value.plugins),
  'a catalog snapshot: adapters, credentials and plugins',
);

export const listenArrivalCaseSchema = z
  .object({
    case: z.string(),
    /** The plan it arrives on, by its name in `plans`. */
    plan: z.string(),
    arrival: planArrivalSchema,
    /** An ISO instant: the judge's `nowMs`. */
    now: z.string(),
    verdict: verdictSchema,
  })
  .strict();
export type ListenArrivalCase = z.infer<typeof listenArrivalCaseSchema>;

export const listenArrivalCasesSchema = z
  .object({
    about: z.string(),
    catalog: catalogSnapshotSchema,
    plans: z.record(z.string(), z.object({ source: z.string(), plan: listenPlanSchema }).strict()),
    cases: z.array(listenArrivalCaseSchema).min(1),
  })
  .strict();
export type ListenArrivalCases = z.infer<typeof listenArrivalCasesSchema>;
