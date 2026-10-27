// Embedding the engine in another product's own process: the embedded host
// that routes a tenant's events, parks and resumes its runs and caches its
// catalog (`createEmbeddedHost`); and the parts it is built from: the in-process host
// to fill with the embedder's own parts (its adapters, models, files, parks),
// the write locks it starts from, the instance schema it reads off each
// adapter it loaded, the routing table it reads off a customer's movement
// (its `listen` statements), and an in-memory store for runs that `await` or
// `sleep`. docs/embedding.md walks through it.

export { inProcessHost, type InProcessHostOptions } from '../services/embed/in_process_host';
export { CredentialNotTenants, type CredentialOwnership } from '../services/translation_graph/engine/adapter_table';
export { introspectAdapter } from '../services/embed/introspect';
export { memoryRunHostStore } from '../services/run_host/memory_store';
export { InMemoryWriteLocks, type WriteLocks } from '../services/write_locks/write_locks';
export { collectFileListeners, type FileListener } from '../services/translation_graph/movement/file_listeners';
export { MovementEngineError, isCheckFailure, type MovementEngineErrorCode } from '../services/movement_engine/errors';
export { pricedModels, type ExtractCallModelClient, type ModelClient } from '../services/embed/models';
export type { LlmCallInput, LlmCallResult } from '../services/translation_graph/engine/batched_extraction/llm_call';
export type { ExtractCallLlmInput, ExtractCallLlmResult } from '../services/translation_graph/engine/batched_extraction/llm_call';
export type { SegmentLimits } from 'engine-contracts';
export {
  createEmbeddedHost,
  memoryEmbeddedHostStore,
  type ConnectableSecrets,
  type Delivery,
  type EmbeddedHost,
  type EmbeddedHostOptions,
  type EmbeddedHostStore,
  type EmbeddedRun,
  type EmbeddedRunLimits,
  type EmbeddedRunOutcome,
  type SaveAnswer,
  type SavedProgram,
  type StoredConnection,
} from '../services/embed/embedded_host';
