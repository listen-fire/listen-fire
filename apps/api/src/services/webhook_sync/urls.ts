// The public callback URL a webhook_subscription row receives events at.
//
// Stable per subscription ROW — and rows are keyed per (provider,
// credential), so the URL is the "stable per-(adapter, credential)
// subscription URL" listen reconciliation diff-syncs against
// (6_engine.md: keyed to the instance, not the listen, so reconciliation
// never changes inbound URLs). Dev / preview / prod each hit a different
// origin — `API_BASE_URL` carries the right one, and its absence is fatal
// rather than defaulted: this used to fall back to `https://example.com`, which
// pointed every third-party subscription at somebody else's deployment.

import { apiBaseUrl } from '../../lib/api_base_url';

export function buildWebhookTargetUrl(provider: string, subscriptionId: string): string {
  return `${apiBaseUrl()}/api/public/webhook-sync/${provider.toLowerCase()}/${subscriptionId}`;
}
