// P22 — "the awaited edge is the park's public identity". Every run surface that
// shows a parked run answers "what is this waiting on?" the SAME way: in plain
// language, derived from the park + the awaitable adapter's correlation, never
// from engine internals. No jargon reaches a person here — no "adapter",
// "correlation", "park", "address", "edge id".
//
// Two park shapes carry an author-chosen wait:
//   • an AWAIT park (`await x-[:E]->`) — described from its `adapter_await` row:
//       ask   → the question it is waiting to be answered
//       slack → a reply it is waiting for in a thread
//   • a TIMER park — a recurring `until` condition ("checking on a schedule")
//       or a one-shot `sleep` ("waiting for a scheduled time").

import { getAsksQb, getAutomationsQb, getQb } from '../../lib/kysely';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { AskId } from '../../generated/kysely/asks/Ask';

/** One plain-language line describing something a run is waiting on. */
export type AwaitDescription = string;

/**
 * Everything a run is currently waiting on, in plain language — one line per
 * live parked leaf. Empty when the run has no author-chosen waits (running, or
 * parked only on an engine hold like a spending limit, which these surfaces
 * describe elsewhere).
 */
export async function describeRunAwaits(runId: TriggerRunId): Promise<AwaitDescription[]> {
  const parked = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('status', '=', 'parked')
    .where('park_reason', 'in', ['await', 'timer'])
    .select(['address', 'park_reason', 'state'])
    .execute();
  if (parked.length === 0) return [];

  const awaitAddresses = parked.filter((p) => p.park_reason === 'await').map((p) => p.address);
  const correlations = awaitAddresses.length > 0 ? await loadCorrelations(runId, awaitAddresses) : new Map();

  // The ask prompts for every ask this run awaits, in one read.
  const askIds = [...correlations.values()]
    .filter((c) => c.adapterType === 'ask')
    .map((c) => c.correlationKey as AskId);
  const prompts = askIds.length > 0 ? await loadAskPrompts(askIds) : new Map<string, string>();

  const out: AwaitDescription[] = [];
  for (const park of parked) {
    if (park.park_reason === 'timer') {
      out.push(describeTimer(park.state));
      continue;
    }
    const corr = correlations.get(park.address);
    if (!corr) {
      // A parked await with no correlation row is a transient inconsistency
      // (mid-drain); describe it honestly rather than inventing an edge.
      out.push('waiting on a response');
      continue;
    }
    out.push(describeAwait(corr, prompts));
  }
  return out;
}

interface Correlation {
  adapterType: string;
  correlationKey: string;
}

async function loadCorrelations(
  runId: TriggerRunId,
  addresses: string[],
): Promise<Map<string, Correlation>> {
  const rows = await getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('run_id', '=', runId)
    .where('address', 'in', addresses)
    .select(['address', 'adapter_type', 'correlation_key'])
    .execute();
  const map = new Map<string, Correlation>();
  for (const r of rows) {
    map.set(r.address, { adapterType: r.adapter_type, correlationKey: r.correlation_key });
  }
  return map;
}

async function loadAskPrompts(askIds: AskId[]): Promise<Map<string, string>> {
  const rows = await getAsksQb(['ask'])
    .selectFrom('ask')
    .where('id', 'in', askIds)
    .select(['id', 'prompt'])
    .execute();
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.id as unknown as string, r.prompt);
  return map;
}

function describeAwait(corr: Correlation, prompts: Map<string, string>): AwaitDescription {
  if (corr.adapterType === 'ask') {
    const prompt = prompts.get(corr.correlationKey);
    return prompt && prompt.trim() !== ''
      ? `waiting for an answer to: ${prompt}`
      : 'waiting for an answer to a question';
  }
  if (corr.adapterType === 'slack') {
    // The correlation key is "<channelId>:<threadTs>" — the channel id is not a
    // name a person recognises, so keep it plain.
    return 'waiting for a reply in a Slack thread';
  }
  return 'waiting for a response';
}

function describeTimer(state: unknown): AwaitDescription {
  const isUntil =
    state !== null &&
    typeof state === 'object' &&
    (state as Record<string, unknown>).until === true;
  return isUntil
    ? 'checking on a schedule for a condition to become true'
    : 'waiting until a scheduled time';
}
