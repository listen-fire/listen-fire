// Barrel for the wave-1 R1 evaluator. Owns:
//
//   - Batcher interface + StubBatcher (test-time)
//   - #extract semantics (`extract.ts`)
//   - #transform semantics (`transform.ts`)
//   - EXTRACT_VALUE semantics (`extract-value.ts`)
//
// The outer `engine/expression.ts` dispatches into these modules from
// its `evaluateExpression` / `walkTraversal` switch arms.

export { StubBatcher } from './batcher';
export type {
  Batcher,
  ExtractInvocation,
  ExtractValueInvocation,
  ExtractScope,
} from './batcher';

export {
  evaluateExtractStep,
  makeExtractState,
  allocateSiteId,
} from './extract';
export type { ExtractState } from './extract';

export { evaluateTransformStep } from './transform';
export type { TransformAugmentation } from './transform';

export { evaluateExtractValue } from './extract-value';
