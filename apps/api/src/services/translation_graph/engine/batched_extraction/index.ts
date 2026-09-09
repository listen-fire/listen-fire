// Barrel — public surface of the wave-1 R2 batched-extraction pipeline.
//
// The pipeline implements R1's `Batcher` interface (`./batcher.ts`) and
// replicates the behavioural nuance of the legacy
// `apps/api/src/services/knowledge_pipeline/extract.ts` +
// `consolidate.ts` over TG primitives:
//
//   - C1 bundle assembly                  → `./bundle.ts`
//   - C2 per-resource fact extraction     → delegated to R8's fact-lifecycle hook
//   - C3 pre-extraction transforms        → `./phases.ts`
//   - C4 synthetic schema build           → `./schema_synthesis.ts`
//   - C5 skeleton pass (conditional)      → `./phases.ts`
//   - C6 context-dependent transforms     → `./phases.ts`
//   - C7 full extraction                  → `./phases.ts`
//   - C8 result rebinding                 → `./rebind.ts`
//   - C9 application target (dedup only)  → `./apply.ts`
//
// Consumers (the TG runner, composition runtime, dev-loop test harness)
// construct a `BatchedExtractionBatcher` and pass it into the evaluator
// as the `batcher` on the eval context.

export { BatchedExtractionBatcher } from './batcher';
export type {
  BatchedExtractionBatcherConfig,
  LlmClient,
  LlmCallInput,
  LlmCallResult,
  FactExtractor,
  TransformDispatcher,
  TransformDispatchResult,
  ApplyTarget,
} from './batcher';

export { assembleBundle } from './bundle';
export type { Bundle, BundleSegment } from './bundle';

export { buildSyntheticSchema, ENTITY_DENSITY_OPUS_THRESHOLD } from './schema_synthesis';
export type { SyntheticSchema, EntityShape, FieldShape } from './schema_synthesis';

export {
  runPreExtractionTransforms,
  runSkeletonPass,
  runContextDependentTransforms,
  runFullExtraction,
  runEntityEnrichment,
  hasEntityEnrichment,
  mergeExtractionResults,
  makeEnrichmentCache,
  type SkeletonResult,
  type FullExtractionResult,
  type EnrichmentInvoker,
  type EnrichmentOutput,
  type EnrichmentContext,
  type EnrichmentCache,
} from './phases';

export { rebindResults, type RebindResult } from './rebind';

export {
  runInBatchDedup,
  type InBatchDedupResult,
  type DedupJudge,
} from './dedup';
