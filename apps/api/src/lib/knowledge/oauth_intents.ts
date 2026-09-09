/**
 * In-memory registry for in-flight OAuth "connect intents" raised by the
 * Setup agent's `connectIntegration` tool.
 *
 * Flow:
 *
 *  1. The Setup agent's tool calls `createConnectIntent({adapterType, userId})`.
 *     It returns an `intentId` and a Promise that will eventually resolve to
 *     a `ConnectIntentResolution` once OAuth completes.
 *  2. The tool emits a `tool_call` agent update carrying the install URL +
 *     the `intentId`. The web layer renders the OAuth widget keyed on the
 *     `intentId`, opens the popup, listens on the `listen-fire-oauth`
 *     BroadcastChannel for the claim token.
 *  3. When the popup posts the claim token back, the web layer invokes the
 *     `completeConnectIntent` tRPC mutation, which claims the pending
 *     credentials, writes the `external_service_credentials` row, and then
 *     calls `resolveConnectIntent` here to release the awaiting Promise.
 *  4. The Setup agent's tool returns; the LLM continues the turn.
 *
 * Cancellation:
 *
 *  - Each intent ages out after `INTENT_TTL_MS` (15 minutes) — same
 *    horizon as the underlying pending-credentials store. After TTL the
 *    intent's promise rejects.
 *  - `failConnectIntent` is exposed so the web layer can surface a
 *    user-dismiss / OAuth error back to the agent immediately rather than
 *    waiting for the TTL.
 *
 * This module is in-process; restarts orphan in-flight intents. That's
 * acceptable: the conversation tombstone will report the failed turn and
 * the user can retry. Persistent durability isn't worth the complexity at
 * this stage.
 */

const INTENT_TTL_MS = 15 * 60 * 1000;

export interface ConnectIntentResolution {
  credentialsId: string;
  name: string;
  adapterType: string;
}

interface PendingIntent {
  intentId: string;
  adapterType: string;
  userId: string;
  resolve: (value: ConnectIntentResolution) => void;
  reject: (err: Error) => void;
  promise: Promise<ConnectIntentResolution>;
  expiresAt: number;
}

const intents = new Map<string, PendingIntent>();

function makeIntentId(): string {
  return `ci-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createConnectIntent({
  adapterType,
  userId,
}: {
  adapterType: string;
  userId: string;
}): { intentId: string; promise: Promise<ConnectIntentResolution> } {
  const intentId = makeIntentId();

  let resolve!: (v: ConnectIntentResolution) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<ConnectIntentResolution>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const entry: PendingIntent = {
    intentId,
    adapterType,
    userId,
    resolve,
    reject,
    promise,
    expiresAt: Date.now() + INTENT_TTL_MS,
  };
  intents.set(intentId, entry);

  setTimeout(() => {
    const current = intents.get(intentId);
    if (!current) return;
    intents.delete(intentId);
    current.reject(new Error('OAuth flow timed out'));
  }, INTENT_TTL_MS);

  return { intentId, promise };
}

export function resolveConnectIntent({
  intentId,
  userId,
  resolution,
}: {
  intentId: string;
  userId: string;
  resolution: ConnectIntentResolution;
}): void {
  const entry = intents.get(intentId);
  if (!entry) throw new Error('Unknown or expired connect intent');
  if (entry.userId !== userId) {
    throw new Error('Connect intent does not belong to this user');
  }
  intents.delete(intentId);
  entry.resolve(resolution);
}

export function failConnectIntent({
  intentId,
  userId,
  reason,
}: {
  intentId: string;
  userId: string;
  reason: string;
}): void {
  const entry = intents.get(intentId);
  if (!entry) return;
  if (entry.userId !== userId) return;
  intents.delete(intentId);
  entry.reject(new Error(reason));
}

/** Test-only: peek at the live intents. */
export function _peekConnectIntents(): string[] {
  return Array.from(intents.keys());
}
