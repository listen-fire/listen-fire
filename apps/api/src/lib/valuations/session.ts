/**
 * The valuations unit's session context (V-17).
 *
 * Its audit trigger, its outbox capture and its RLS policies all read GUCs the
 * unit owns — `valuations.team_id`, `valuations.actor_{type,id}` and
 * `valuations.context_id` — rather than core's `core.current_*`. Whoever wraps
 * a request sets them from the Principal; standalone that is the unit's own
 * express wrapper, composed it is the shared Context (see
 * `services/context`, which is the only caller today).
 *
 * Absent them a write is attributed to `system`, which is the correct answer
 * for a worker or a migration and the wrong one for a request — so the wrapper
 * setting them is load-bearing, not decorative.
 */

type ValuationsActor =
  | { type: 'api-token'; id: string }
  | { type: 'user'; id: string }
  | { type: 'system'; id: null };

function actorFrom({ userId, apiKeyId }: { userId?: string; apiKeyId?: string }): ValuationsActor {
  if (apiKeyId) return { type: 'api-token', id: apiKeyId };
  if (userId) return { type: 'user', id: userId };
  return { type: 'system', id: null };
}

/**
 * The four values the unit's triggers read, in the order
 * `valuations.set_session_context` takes them.
 */
function sessionContextArgs({
  teamId,
  userId,
  apiKeyId,
  contextId,
}: {
  teamId: string;
  userId?: string;
  apiKeyId?: string;
  contextId: string;
}): [string, string, string, string] {
  const actor = actorFrom({ userId, apiKeyId });
  return [teamId, actor.type, actor.id ?? '', contextId];
}

export { actorFrom, sessionContextArgs };
export type { ValuationsActor };
