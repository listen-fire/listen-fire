/**
 * The automations unit's session context.
 *
 * Its nine audit triggers and its two `agent` row-level-security policies read
 * GUCs the unit owns — `automations.team_id`, `automations.actor_{type,id}` and
 * `automations.context_id` — rather than the `core.current_*` set core mints.
 * Whoever wraps a request sets them from the Principal; standalone that is
 * automations' own wrapper, composed it is the shared Context (see
 * `services/context`, the only caller today).
 *
 * The set is deliberately a COPY of the valuations, core and knowledge ones
 * rather than a shared helper: the four become separate repos, and a session
 * derivation one imports from another is a coupling none of them wants (D12).
 *
 * Absent them a write is attributed to `system` and the agent role sees
 * nothing — the correct answers for a worker and for an unscoped connection,
 * and the wrong ones for a request. The wrapper setting them is load-bearing.
 *
 */

type AutomationsActor =
  | { type: 'api-token'; id: string }
  | { type: 'user'; id: string }
  | { type: 'system'; id: null };

function actorFrom({ userId, apiKeyId }: { userId?: string; apiKeyId?: string }): AutomationsActor {
  if (apiKeyId) return { type: 'api-token', id: apiKeyId };
  if (userId) return { type: 'user', id: userId };
  return { type: 'system', id: null };
}

/**
 * The four values the unit's triggers and policies read, in the order
 * `automations.set_session_context` takes them.
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
export type { AutomationsActor };
