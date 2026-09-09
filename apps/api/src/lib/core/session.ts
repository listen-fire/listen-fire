/**
 * The core unit's session context.
 *
 * Core's audit trigger reads GUCs the unit owns — `core.team_id`,
 * `core.actor_{type,id}` and `core.context_id` — rather than the
 * `core.current_*` set it used to share with everything else. Whoever wraps a
 * request sets them from the Principal; standalone that is core's own express
 * wrapper, composed it is the shared Context (see `services/context`, which is
 * the only caller today).
 *
 * The set is deliberately a COPY of the valuations one rather than a shared
 * helper: the two units become separate repos, and a session derivation that
 * one imports from the other is a coupling neither wants (D12).
 *
 * Absent them a write is attributed to `system`, which is the correct answer
 * for a worker or a migration and the wrong one for a request — so the wrapper
 * setting them is load-bearing, not decorative.
 */

type CoreActor =
  | { type: 'api-token'; id: string }
  | { type: 'user'; id: string }
  | { type: 'system'; id: null };

function actorFrom({ userId, apiKeyId }: { userId?: string; apiKeyId?: string }): CoreActor {
  if (apiKeyId) return { type: 'api-token', id: apiKeyId };
  if (userId) return { type: 'user', id: userId };
  return { type: 'system', id: null };
}

/**
 * The four values the unit's triggers read, in the order
 * `core.set_session_context` takes them.
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
export type { CoreActor };
