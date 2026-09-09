// Registering a delivery webhook with the graph — the standalone deployment's
// delivery path (D39(c)).
//
// It lives beside the adapter, and not inside it, for the reason the valuations
// pair does: two callers need it. The adapter's `ensureEventSubscription` calls
// it when a listen is reconciled, and the webhook-sync provider calls it when a
// subscription is (re)registered from the operator side. One implementation, so
// the two cannot register subtly different endpoints and then disagree about
// which secret verifies the delivery.

import { kgFetch, loadKgCredentials } from './kg_client';

/**
 * Register a delivery webhook, idempotently.
 *
 * The URL is the identity: the graph keys endpoints by it and issues no handle
 * of its own, so it is both the argument and the `externalId` handed back for
 * deregistration. Re-registering with a changed event selection is the normal
 * case — a listen's `events:` moves — and re-POSTing is how that is expressed.
 *
 * **The graph issues the secret** (K-28). The alternative, generating it here
 * and telling the graph what to use, makes the SENDER trust the receiver's
 * choice of key; this way the value the drainer signs with is the value the
 * registration returned, and there is one place it can come from.
 *
 * An empty `eventTypes` means every event the graph emits — the registration
 * endpoint's own convention.
 */
export async function registerKnowledgeWebhook(input: {
  credentialsId: string;
  /** Optional: an intrinsic credential's key is team-anchored, so the graph
   *  already knows. Passed where the caller has it, so a key that ISN'T
   *  anchored still resolves rather than failing on ambiguity. */
  teamId?: string;
  targetUrl: string;
  eventTypes: string[];
}): Promise<{ externalId: string; secret: string }> {
  const registered = await kgFetch<{ url: string; secret: string }>(
    await loadKgCredentials(input.credentialsId),
    {
      method: 'POST',
      path: '/webhooks',
      body: { url: input.targetUrl, eventTypes: input.eventTypes, team: input.teamId },
    },
  );
  return { externalId: registered.url, secret: registered.secret };
}

/** Deregister by the target URL (`externalId`) — the graph keys endpoints by it. */
export async function deregisterKnowledgeWebhook(input: {
  credentialsId: string;
  teamId?: string;
  externalId: string;
}): Promise<void> {
  await kgFetch(await loadKgCredentials(input.credentialsId), {
    method: 'DELETE',
    path: '/webhooks',
    query: { url: input.externalId, team: input.teamId },
  });
}
