// The engine's front door: run a movement, resume a parked one, check a
// program. The engine runs a pin that shares this release's compatibility
// key; any other is refused by name, with the remedy.

import { LANGUAGE_VERSION } from 'movement-lang';

export { fireCallbackBody, resumeMovement, runMovement, settleRaceFrame } from '../services/movement_engine/rust_run';
export { MovementRunFailed, RunCancelledSignal, runFailureCause } from '../services/movement_engine/errors';
export type {
  CancelGate,
  MovementRunResult,
  MovementWriteRecord,
  ParkSink,
  ResumeMovementInput,
  RunLimitPause,
  RunMovementInput,
} from '../services/movement_engine/run_types';

// A process's boot refuses the retired engine settings.
export { assertEngineConfigured } from '../services/movement_engine/rust_engine';

// What the Rust engine did in this process, counted.
export * from '../services/movement_engine/rust_stats';

export * as programCheck from '../services/movement_engine/program_check';
export {
  checkAnswerInRust,
  checkPinnedInRust,
  parsePinned,
  throwIfBlocking,
  type CheckAnswer,
  type CheckInput,
  type LinkData,
  type LinkedImportData,
  type Stamp,
} from '../services/movement_engine/program_check';
export { checkInputOf } from '../services/movement_engine/rust_run';

/** This release of the engine, which is the language it reads
 *  (`LANGUAGE_VERSION`): a run pinned to a release of another compatibility
 *  key is refused by name. */
export const ENGINE_VERSION: string = LANGUAGE_VERSION;
