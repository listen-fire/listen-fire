import { getFlowConnectToken } from './oauthFlows';
import { apiBaseUrl } from './api_base_url';

/**
 * Decide where an adapter's OAuth callback should redirect after it has stored
 * the freshly-exchanged tokens as pending credentials (keyed by `claimToken`).
 *
 * Two flows share the connector callbacks:
 *   - In-app popup connect: redirect to the connector's web callback page
 *     (`callbackUrl`), which broadcasts the claimToken over BroadcastChannel to
 *     the chat panel, which then calls `addCredential`. (UNCHANGED.)
 *   - Author-time connect LINK: the OAuth flow carries a `connectToken` (bound
 *     when the landing page started the OAuth). Redirect instead to the
 *     connect-landing `/complete` route, which claims + persists the credential
 *     server-side — no popup, no BroadcastChannel.
 *
 * The branch is keyed off the OAuth `state` → `connectToken` binding, so the
 * popup flow is byte-for-byte unchanged (no connectToken → `callbackUrl`).
 *
 */
export function resolveOAuthCallbackRedirect(input: {
  state: string;
  claimToken: string;
  /** The connector's configured web callback page (popup-flow default). */
  callbackUrl: string;
}): string {
  const connectToken = getFlowConnectToken(input.state);
  if (connectToken) {
    const base = apiBaseUrl();
    const url = new URL(`${base}/api/connect/${encodeURIComponent(connectToken)}/complete`);
    url.searchParams.set('claimToken', input.claimToken);
    return url.toString();
  }

  const url = new URL(input.callbackUrl);
  url.search = '';
  url.searchParams.set('claimToken', input.claimToken);
  return url.toString();
}
