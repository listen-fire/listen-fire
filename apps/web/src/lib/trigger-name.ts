// A movement-derived trigger's own name is the internal dispatch key
// `movement/<file>/<lane>` (see `apps/api/src/lib/automation/naming.ts`,
// the server-side counterpart used wherever a real movement join is on
// hand). The two display-only spots here — the movement activity list and
// the trigger detail header — only ever have the raw name on the client,
// so this stays a tiny local parser rather than a shared package import.
export function parseTriggerName(name: string): { automation: string; lane: string | null } {
  const parts = name.split("/");
  if (parts.length !== 3 || parts[0] !== "movement") return { automation: name, lane: null };
  const [, automation, lane] = parts;
  return { automation, lane: lane === automation ? null : lane };
}

/** The activity list's per-run lane label: the distinguishing lane, or
 *  "default" when a single-listener movement has none to distinguish. */
export function laneShortForm(triggerName: string): string {
  return parseTriggerName(triggerName).lane ?? "default";
}
