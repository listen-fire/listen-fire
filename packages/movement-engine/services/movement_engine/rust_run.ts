// The engine's run entry: run a movement, resume a parked one, settle a race
// frame, fire a callback's body. Each opens one segment (`inRunContext`) and
// runs it on the Rust engine (rust_engine.ts). The engine runs a pin that
// shares this release's compatibility key; any other is refused at the
// entry, by name, with the remedy. Saved movements of an older language run
// where they were saved, on a platform that keeps an engine for them.

import { LANGUAGE_VERSION, languageVersionDiagnostic } from 'movement-lang';
import {
  refuseUnsupportedParkStateVersion,
  type CallbackBodyInput,
  type RunInput,
  type SettleRaceInput,
} from 'engine-contracts';

import { MovementEngineError, MovementRunFailed, PARKED_ON_TYPESCRIPT } from './errors';
import type { EngineHost } from './host';
import { withIsoEvent } from './host_adapter';
import { checkPinnedInRust, type CheckInput } from './program_check';
import {
  checkBeforeRustSegment,
  fireSegmentInRust,
  resumeSegmentInRust,
  runSegmentInRust,
  settleSegmentInRust,
} from './rust_engine';
import type { MovementRunResult, ResumeMovementInput, RunMovementInput } from './run_types';
import { inRunContext } from './segment_context';

export async function runMovement(given: RunMovementInput): Promise<MovementRunResult> {
  const input = withIsoEvent(given);
  refuseEarlierPin(input);
  // The program is checked here, by the Rust checker, before its segment
  // opens, so a program that fails its check makes no host request. The
  // engine then checks it again itself (`nativeCheck`), its stamps and import
  // link that check's; the host is never asked.
  checkBeforeRustSegment(input, () => checkPinnedInRust(checkInputOf(input)));
  return inRunContext(input, (context) => runSegmentInRust({ input, context, checkedBefore: true }));
}

/**
 * Resume a parked movement run forward from its parked leaf. The `source` MUST
 * be the version-pinned source the run parked against, so every lexical
 * address is byte-identical.
 */
export async function resumeMovement(given: ResumeMovementInput): Promise<MovementRunResult> {
  const input = withIsoEvent(given);
  refuseUnsupportedParkStateVersion(input.state.version);
  refuseEarlierPin(input);
  checkBeforeRustSegment(input, () => checkPinnedInRust(checkInputOf(input)));
  return inRunContext(input, (context) => resumeSegmentInRust({ input, context, checkedBefore: true }));
}

/**
 * Settle a race frame whose branches completed under batch resume: called by
 * the await-resume worker once per deferred frame after the whole batch pass.
 */
export async function settleRaceFrame(given: SettleRaceInput & { host: EngineHost }): Promise<MovementRunResult> {
  const input = withIsoEvent(given);
  refuseUnsupportedParkStateVersion(input.state.version);
  refuseEarlierPin(input);
  checkBeforeRustSegment(input, () => checkPinnedInRust(checkInputOf(input)));
  return inRunContext(input, (context) => settleSegmentInRust({ input, context, checkedBefore: true }));
}

/**
 * Run a fired callback's body against its captured continuation. `source` MUST
 * be the run's version-pinned source, so the address resolves to the same
 * expression it was minted from.
 */
export async function fireCallbackBody(given: CallbackBodyInput & { host: EngineHost }): Promise<MovementRunResult> {
  const input = withIsoEvent(given);
  refuseUnsupportedParkStateVersion(input.state.version);
  refuseEarlierPin(input);
  checkBeforeRustSegment(input, () => checkPinnedInRust(checkInputOf(input)));
  return inRunContext(input, (context) => fireSegmentInRust({ input, context, checkedBefore: true }));
}

/**
 * A run pinned to a language this release does not read is refused, by the
 * pin's standing. A run the TypeScript engine parked (under the retired
 * MOVEMENT_ENGINE_V5_ON_TS switch) has no engine to resume on.
 */
function refuseEarlierPin(input: RunInput & { parkedOnEngine?: 'ts' | 'rust' }): void {
  const languageVersion = input.languageVersion ?? LANGUAGE_VERSION;
  const refusal = languageVersionDiagnostic(languageVersion);
  if (refusal !== undefined) throw new MovementEngineError('MOVENG_LANGUAGE_VERSION', refusal.message);
  if (input.parkedOnEngine === 'ts') {
    throw new MovementEngineError(
      'MOVENG_UNSUPPORTED',
      `this run is pinned to language ${languageVersion}, which runs only on the Rust engine, but the TypeScript engine parked it: it cannot resume`,
      { reason: PARKED_ON_TYPESCRIPT },
    );
  }
}

/** What the check reads of a run's input. */
export function checkInputOf(input: RunInput): CheckInput {
  return {
    source: input.source,
    catalog: input.catalog,
    ...(input.languageVersion !== undefined ? { languageVersion: input.languageVersion } : {}),
  };
}
