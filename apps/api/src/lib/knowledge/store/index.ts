// The knowledge store's write door — the one way graph state changes.

export {
  createNode,
  deleteEdge,
  deleteNode,
  deleteNodes,
  deleteProperties,
  inTransaction,
  link,
  loadPropertyTypes,
  openKnowledgeStore,
  retargetEdge,
  setProperties,
  unlink,
} from './write';
export type {
  CreateNodeInput,
  CreateNodeResult,
  EdgeAssertion,
  KnowledgeWriteDb,
  LinkInput,
  PropertyAnchor,
  PropertyWrite,
  WriteContext,
  WrittenProperty,
} from './write';
export { serializeNodeAsText, summarizeNodes } from './summarize';
export type { SummarisableNode } from './summarize';
export { findCandidates, lockNaturalKey, projectUniqueness, uniquenessFor } from './identity';
export type { CandidateMatch, UniquenessConstraints, UniquenessEntry } from './identity';
export { mergeEdges, mergeNodes } from './merge';
export type { PropertyToReEvaluate } from './merge';
export { KnowledgeWriteRefused } from './values';
export type { PropertyTypeFacts } from './values';
