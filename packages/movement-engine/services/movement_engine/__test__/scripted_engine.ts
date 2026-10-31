// A scripted double of the Rust engine's half of the request/answer protocol,
// for the shim's tests: no WASM. The real artifact's half is
// rust_engine_abi.unit.test.ts.

import { EMPTY_CATALOG_SNAPSHOT, LANGUAGE_VERSION, type CatalogSnapshot } from 'movement-lang';

import { tenantIdOf } from 'engine-contracts';

import { openRunContext } from '../segment_context';
import { makeTestHost, type TestHostOverrides } from '../test_host';
import type { EngineProtocol, EngineStep, HostAnswer, HostRequest } from '../rust_engine';

export const TEAM = tenantIdOf('team-1');

/** A double that issues what `script` says, step by step: each reply is
 *  computed from every answer received so far, so a test can assert both
 *  what the shim answered and in what order. */
export function scriptedEngine(script: (answers: Array<{ id: number; answer: HostAnswer }>) => EngineStep): {
  engine: EngineProtocol;
  answers: Array<{ id: number; answer: HostAnswer }>;
  started: unknown[];
  finished: () => boolean;
} {
  const answers: Array<{ id: number; answer: HostAnswer }> = [];
  const started: unknown[] = [];
  let finished = false;
  return {
    engine: {
      start(input) {
        started.push(input);
        return script(answers);
      },
      answer(id, answer) {
        answers.push({ id, answer });
        return script(answers);
      },
      finish() {
        finished = true;
      },
    },
    answers,
    started,
    finished: () => finished,
  };
}

export function request(id: number, family: string, method: string, args: unknown): HostRequest {
  return { id, family, method, args };
}

/** The driver's input: a test host, and a segment opened on it as the run
 *  host opens one. */
export async function hostWith(overrides: TestHostOverrides, catalog: CatalogSnapshot = EMPTY_CATALOG_SNAPSHOT) {
  const host = makeTestHost(overrides);
  // The pins in this file are the protocol's fixtures: scripted engines and
  // programs no version reads differently, so this release's throughout.
  const context = await openRunContext({ host, teamId: TEAM, languageVersion: LANGUAGE_VERSION, spend: {} });
  return { host, context, catalog };
}

/** A request bound for the host names the segment the driver serves. */
export function inSegment(segmentId: string, args: Record<string, unknown>): Record<string, unknown> {
  return { segmentId, ...args };
}
