// The host's half of a run SEGMENT: its run scope (what its adapter calls
// have already read, and how many third-party calls they have made:
// `module-runtime/run_scope`), which language version they answer under, and
// what they spent on priced work of their own. The engine opens a segment
// through the host's `segment` family and names it on every adapter call; the
// host runs each call inside the segment's scope (`segmentScopedCalls`).
//
// The scope is ambient INSIDE the host, on purpose: the API clients are
// process-wide singletons shared by every run in the process, far below the
// adapter method that reached them, so the segment has to arrive the way the
// billing context does. The engine never reads it — it only holds the
// segment's id.

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import { RunScope, inRunScope, isAdapterCallCeilingExceeded } from 'module-runtime/run_scope';

import { LANGUAGE_VERSION, type LanguageVersion } from 'movement-lang';

import { tenantIdOf, type TenantId } from 'engine-contracts';

import type { EngineHost, SegmentOpening } from '../movement_engine/host';

import { NO_BUDGET_LIMIT, type CostLine } from '../../lib/run_cost';
import { SpendMeter, underSpendMeter } from '../../lib/run_spend';
import { logger } from '../logger';
import { adapterErrorOf, type ClassifyHostError } from './engine/adapter_table';

// ── The segment ─────────────────────────────────────────────────────────────

class SegmentScope {
  readonly run = new RunScope();
  /** What the segment's adapter calls spent on priced work of their own — a
   *  model call an adapter makes to match a record. Unbudgeted: an adapter
   *  call carries no budget, so the run's cap meets this spend when the
   *  segment closes and charges it. */
  readonly spend = new SpendMeter(NO_BUDGET_LIMIT);

  constructor(
    readonly tenantId: TenantId,
    readonly languageVersion: LanguageVersion,
    readonly runId: string | undefined,
  ) {}
}

const openSegments = new Map<string, SegmentScope>();
const asyncLocalStorage = new AsyncLocalStorage<SegmentScope>();

function segmentNamed(segmentId: string): SegmentScope {
  const scope = openSegments.get(segmentId);
  if (scope === undefined) {
    throw new Error(`no open segment '${segmentId}': an adapter call named a segment that was never opened, or one that has closed`);
  }
  return scope;
}

/** Open a segment: a fresh memo, a fresh count. The host families version is
 *  the host's to check, before it opens one (`openSegmentWith`). */
export async function openSegment(input: Omit<SegmentOpening, 'hostFamiliesVersion'>): Promise<{ segmentId: string }> {
  const segmentId = randomUUID();
  openSegments.set(segmentId, new SegmentScope(input.teamId, input.languageVersion, input.runId));
  return { segmentId };
}

/** Close a segment, answering what its adapter calls spent. Closing one that
 *  is not open answers nothing: the close in a `finally` must not mask the
 *  failure it is cleaning up after. */
export async function closeSegment(input: { segmentId: string }): Promise<{ cost: CostLine[] }> {
  const scope = openSegments.get(input.segmentId);
  openSegments.delete(input.segmentId);
  return { cost: scope?.spend.cost() ?? [] };
}

/** The host's `segment` family. */
export const hostSegments: EngineHost['segment'] = { open: openSegment, close: closeSegment };

function inScope<T>(scope: SegmentScope, fn: () => T): T {
  return asyncLocalStorage.run(scope, () => inRunScope(scope.run, () => underSpendMeter(scope.spend, fn)));
}

/** Run `fn` inside an open segment's scope — what every call into a
 *  segment-bound adapter does. */
export function inSegment<T>(segmentId: string, fn: () => T): T {
  return inScope(segmentNamed(segmentId), fn);
}

/** Open a segment, run `fn` inside it, close it — for code that is a segment
 *  of its own rather than a run's (scripts, tests of the scope itself). */
export async function withSegment<T>(
  input: Omit<Partial<SegmentOpening>, 'teamId'> & { teamId: string },
  fn: () => Promise<T>,
): Promise<T> {
  const { segmentId } = await openSegment({
    teamId: tenantIdOf(input.teamId),
    languageVersion: input.languageVersion ?? LANGUAGE_VERSION,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
  });
  try {
    return await inSegment(segmentId, fn);
  } finally {
    await closeSegment({ segmentId });
  }
}

/**
 * How the production host runs an adapter call (`adapter_table.ts`): inside
 * its segment's scope, so the call reads through the segment's memo, counts
 * against its ceiling and answers under its pin; and with what it threw turned
 * into the typed answer the engine contract names. A call into a segment that
 * has closed fails, naming it.
 *
 * The engine is answered the failure's message, name and particulars; its
 * class, stack and cause stay here, so the host logs the original as it
 * classifies it. An adapter call carries no budget (its own priced work is
 * charged as the segment closes), so it is never refused as `budget`.
 */
export const segmentScopedCalls: {
  around: <T>(segmentId: string, call: () => Promise<T>) => Promise<T>;
  classify: ClassifyHostError;
} = {
  around: (segmentId, call) => inSegment(segmentId, call),
  classify: (error, { segmentId }) => {
    if (isAdapterCallCeilingExceeded(error)) return { kind: 'call_ceiling', message: error.message };
    logger.warn('[segment_scope] adapter call failed', {
      segmentId,
      runId: openSegments.get(segmentId)?.runId,
      err: error,
    });
    return adapterErrorOf(error);
  },
};

// ── What an adapter reads off its segment ───────────────────────────────────

/**
 * The language version the current segment is pinned to — what an adapter's
 * `since`/`before` conditional reads. Outside a segment (CLI scripts, catalog
 * describe, tests) there is no pin and this is the current version.
 */
export function currentLanguageVersion(): LanguageVersion {
  return asyncLocalStorage.getStore()?.languageVersion ?? LANGUAGE_VERSION;
}

// What an adapter reads off its run: the segment's run scope, ambient.
export {
  AdapterCallCeilingExceeded,
  bindAdapterCallCounter,
  countAdapterCall,
  currentRunCallCount as currentSegmentCallCount,
  fillMemoisedRead,
  forgetMemoisedReads,
  forgetMemoisedReadsUnder,
  isAdapterCallCeilingExceeded,
  memoisedRead,
  type AdapterCallSystem,
} from 'module-runtime/run_scope';
