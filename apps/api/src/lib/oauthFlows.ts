const TTL_MS = 15 * 60 * 1000;

interface FlowEntry {
  userId: string;
  expiresAt: number;
  // Set only for the author-time connect-LINK flow: the connect_token whose
  // landing page started this OAuth. When present, the connector callback
  // redirects back to the connect-landing `/complete` route (which persists the
  // credential server-side) instead of the popup's web BroadcastChannel page.
  connectToken?: string;
}

const flows = new Map<string, FlowEntry>();

function bindFlowToUser(state: string, userId: string, options?: { connectToken?: string }) {
  flows.set(state, {
    userId,
    expiresAt: Date.now() + TTL_MS,
    ...(options?.connectToken ? { connectToken: options.connectToken } : {}),
  });
  setTimeout(() => flows.delete(state), TTL_MS);
}

function getFlowUserId(state: string): string | undefined {
  const entry = flows.get(state);
  if (!entry || entry.expiresAt < Date.now()) {
    flows.delete(state);
    return undefined;
  }
  // Don't delete — concurrent requests (React strict mode) may need the same state.
  // The entry expires naturally via setTimeout.
  return entry.userId;
}

/** The connect_token bound to this OAuth flow, if it was a connect-LINK flow. */
function getFlowConnectToken(state: string): string | undefined {
  const entry = flows.get(state);
  if (!entry || entry.expiresAt < Date.now()) {
    flows.delete(state);
    return undefined;
  }
  return entry.connectToken;
}

function extractStateFromUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('state') ?? undefined;
  } catch {
    return undefined;
  }
}

export { bindFlowToUser, getFlowUserId, getFlowConnectToken, extractStateFromUrl };
