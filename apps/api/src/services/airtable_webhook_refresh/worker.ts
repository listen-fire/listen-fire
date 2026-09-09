// Airtable webhook refresh worker — keeps movement-derived Airtable webhooks
// alive past Airtable's 7-day expiry.
//
// Airtable disables a webhook 7 days after its last activity. An inbound
// delivery already extends that window (we pull the payload feed, which Airtable
// counts as activity), so a busy webhook never needs help — only QUIET ones do.
// `webhook_subscription.updated_at` advances on every checkpoint write (i.e.
// every pull) and on an explicit refresh here, so it tracks "last time the
// window was extended". This worker refreshes any Airtable subscription whose
// window is older than REFRESH_AFTER, well before the 7-day cliff.
//
// A plain `lib/worker` interval loop, sibling of the cron scheduler and the
// poll-source poller. Failures are contained per row — one bad credential never
// starves the rest. Process safety: startup.ts runs it under the application
// advisory lock, so exactly one scanner runs cluster-wide.

import { HOUR } from '../../constants';
import { getAutomationsQb } from '../../lib/kysely';
import { worker } from '../../lib/worker';
import { logger } from '../logger';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { WebhookSubscriptionId } from '../../generated/kysely/automations/WebhookSubscription';
import { MOVEMENT_LISTEN_PROVISIONER } from '../translation_graph/movement/listen_subscriptions';
import { createAirtableAdapter } from '../translation_graph/adapters/airtable';

/** The webhook_subscription.provider key for Airtable (the uppercase trigger
 *  kind; see webhook_sync/providers/index.ts). */
const AIRTABLE_PROVIDER_KEY = 'AIRTABLE';

const SCAN_INTERVAL = HOUR;
/** Refresh once a webhook's window is older than this — 1 day of headroom
 *  before Airtable's 7-day expiry. */
const REFRESH_AFTER = 6 * 24 * HOUR;

/** Parse a `scope` jsonb cell (object, or a serialized string from test fakes)
 *  into a flat string map. */
function scopeOf(rawValue: unknown): Record<string, string> {
  let raw = rawValue;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (raw === null || typeof raw !== 'object') return {};
  const scope: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') scope[k] = v;
  }
  return scope;
}

export async function refreshDueAirtableWebhooks(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - REFRESH_AFTER);
  const rows = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('provider', '=', AIRTABLE_PROVIDER_KEY)
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .where('status', '=', 'active')
    .where('external_webhook_id', 'is not', null)
    .where('updated_at', '<', cutoff)
    .select([
      'id',
      'team_id',
      'credentials_id',
      'external_webhook_id',
      'scope',
    ])
    .execute();

  for (const row of rows) {
    try {
      if (row.credentials_id === null || row.external_webhook_id === null) continue;
      const scope = scopeOf(row.scope);
      if (typeof scope.base !== 'string') {
        logger.warn('[AirtableWebhookRefresh] subscription has no base scope; skipping', {
          subscriptionId: row.id,
        });
        continue;
      }

      const adapter = createAirtableAdapter({
        teamId: row.team_id as TeamId,
        credentialsId: row.credentials_id as unknown as string,
      });
      await adapter.refreshEventSubscription({
        externalId: row.external_webhook_id,
        scope,
      });

      // Advance the window mark so it isn't re-refreshed until the next cycle.
      await getAutomationsQb(['webhook_subscription'])
        .updateTable('webhook_subscription')
        .set({ updated_at: now })
        .where('id', '=', row.id as WebhookSubscriptionId)
        .execute();

      logger.info('[AirtableWebhookRefresh] refreshed webhook', {
        subscriptionId: row.id,
        webhookId: row.external_webhook_id,
      });
    } catch (err) {
      logger.error('[AirtableWebhookRefresh] refresh failed for subscription', {
        subscriptionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function startAirtableWebhookRefresh(): void {
  worker(refreshDueAirtableWebhooks, SCAN_INTERVAL);
}
