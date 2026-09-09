// Normalising a listen's `events` config.
//
// Authored syntax is always a list (`events: ["x", "y"]`) — the checker rejects
// a bare string. But a stored config may still be a bare string: one authored
// before that rule, or written directly. Downstream readers want a uniform
// string[] regardless:
//   - subscription registration (`desiredChannels`) computes the channel's
//     event set to register with the source;
//   - dispatch-time scope filtering (`eventMatchesTriggerScope`) gates each
//     inbound event against the trigger's chosen events.
// A bare-string `events` used to fall through to "all events" — the source
// over-registered AND the dispatch filter matched everything, so a listen scoped
// to one event fired on all of them. Normalise here so any stored shape reads
// the same.

export function eventConfigList(events: unknown): string[] {
  if (Array.isArray(events)) return events.filter((e): e is string => typeof e === 'string');
  if (typeof events === 'string') return [events];
  return [];
}

/**
 * Whether a trigger's `channels` listen filter admits an event in `channelName`
 * (Slack's `listen … { channels: ["dealflow", ...] }`, matched by name).
 *   - No `channels` set → always true (the listener isn't channel-scoped).
 *   - Scoped → true only when the resolved channel name is in the list.
 *   - A scoped listener whose event channel couldn't be resolved (`null`) never
 *     matches — we don't fire on a channel we can't confirm is in scope.
 * The channel-name resolution itself is the caller's (async) concern; this is
 * the pure decision, kept dependency-free so it's unit-testable in isolation.
 */
export function channelScopeMatches(config: unknown, channelName: string | null): boolean {
  const channels = eventConfigList((config as { channels?: unknown } | null)?.channels);
  if (channels.length === 0) return true;
  return channelName != null && channels.includes(channelName);
}
