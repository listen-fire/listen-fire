import { MQ } from '../native';

/**
 * Something in the workspace changed — a hint that an open UI surface may
 * be stale, NOT a data payload. Source-agnostic: published wherever a
 * change actually happens (the shared service / data layers), so it fires
 * the same whether the edit came from the assistant, a user action, the
 * public API, or the extraction pipeline.
 *
 * Emit points (the shared chokepoints, so every caller is covered once):
 *   - `recordChanges` (lib/knowledge/changes) → kg-data (agent CRUD, UI
 *     graph mutations, and pipeline writes all funnel through it);
 *   - `saveMovement` / `deleteMovement` services → movement;
 *   - the ontology tRPC router's mutation middleware → ontology (UI), plus
 *     the agent's ontology tools.
 *
 * Consumers (`onResourceChange`) decide what to do per kind — refetch, or
 * a "refresh" affordance when a refetch would disturb an open edit.
 */
export interface ResourceChangeEvent {
  kind: 'ontology' | 'movement' | 'kg-data';
  teamId: string;
  /** Where the change originated — informational; consumers rarely branch on it. */
  source: 'agent' | 'user' | 'api' | 'pipeline';
  /** The tool/operation, e.g. 'createNodeType' / 'saveMovement' / 'recordChanges'. */
  action: string;
  /** The affected resource where one is obvious (movement id, node/edge id).
   *  Coarse — consumers refetch their own query. */
  resourceId?: string;
  /** The client TAB that made the change, for a DIRECT edit. Consumers
   *  ignore events carrying their own origin (a tab already reflects its
   *  own edits). Absent for agent / pipeline / API changes — those should
   *  refresh every tab, including the one that requested them. */
  originId?: string;
}

const resourceChangesExchange = new MQ<ResourceChangeEvent>().setPresets({
  changed: {
    name: 'resourceChange.changed',
    type: 'fanout',
  },
  changedByTeamId: {
    name: 'resourceChange.changed.teamId',
    type: 'direct',
    key: 'teamId',
    keyPrefix: 'resourceChange.changed.teamId.',
  },
});

const { changed, changedByTeamId } = resourceChangesExchange;

changedByTeamId.attachTo(changed);

export { resourceChangesExchange };
