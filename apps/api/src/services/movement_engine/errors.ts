// The movement engine's error type — extracted to a dependency-free module
// so light modules (the name translator, consumed by the catalog's editor
// snapshot path) can throw the engine's currency without dragging in the
// evaluator's heavy import graph. `expression.ts` re-exports both symbols,
// so existing import sites are unchanged.

export type MovementEngineErrorCode =
  | 'MOVENG_PARSE'
  | 'MOVENG_CHECK'
  // The movement is pinned to a language version this release does not
  // support. Refused before parsing — never run as the current version.
  | 'MOVENG_LANGUAGE_VERSION'
  | 'MOVENG_NOT_FOUND'
  | 'MOVENG_UNSUPPORTED'
  | 'MOVENG_RUNTIME'
  // Calls nested deeper than MOVEMENT_MAX_CALL_DEPTH (language version 3) —
  // a recursion that may never end. Never forgiven by a collection op's
  // `onError` (`call_depth.ts`).
  | 'MOVENG_CALL_DEPTH'
  // A parked scope held a non-JSON-serialisable value (a closure / Map / a
  // value that stringifies to undefined). Fails LOUD at park rather than
  // corrupting the durable scope (async user interaction §4.1).
  | 'MOVENG_PARK_NONSERIALIZABLE'
  // An author-thrown `ERROR("…")` — the movement deliberately failed the run
  // (async user interaction §3c). Surfaced as a FAILED trigger_run.
  | 'MOVENG_ERROR';

export class MovementEngineError extends Error {
  constructor(
    readonly code: MovementEngineErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.name = 'MovementEngineError';
  }
}
