// Credentialed Gmail client resolution — shared by the read Adapter (index.ts)
// and the PollSource (poll.ts). The wire shape itself lives in
// `adapters/gmail/apiClient.ts`; this is only the credential half.

import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb } from '../../../../lib/kysely';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';
import { isDelegatedGmail } from '../../../credentials/app_id';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';
import {
  GmailApiClient,
  checkGmailMailboxAllowed,
  gmailCredsParser,
} from '../../../../adapters/gmail/apiClient';

export type { GmailApiClient };

/**
 * Construct a client for a team's connected mailbox. Returns null when no
 * credential is wired, when the row belongs to the RETIRED per-user sign-in
 * (`app_id` says so without anything being decrypted), or when the stored
 * payload doesn't parse — the caller turns that into a clear "connect Gmail"
 * error, which is a better diagnostic than an impersonation failure.
 *
 * THROWS, rather than returning null, when the credential is real but its
 * mailbox is not (or no longer) on this installation's allowlist — a
 * credential connected under a wider list must stop working the moment the
 * list narrows, and the run's trace should say why, not just that Gmail
 * needs reconnecting.
 */
export async function resolveGmailClient(input: {
  teamId: TeamId;
  credentialsId?: string;
}): Promise<GmailApiClient | null> {
  if (!input.credentialsId) return null;
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', input.credentialsId as ExternalServiceCredentialsId)
    .where('team_id', '=', input.teamId)
    .select(['id', 'credentials', 'app_id'])
    .executeTakeFirst();
  if (!row) return null;
  if (!isDelegatedGmail(row.app_id)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(await decryptToken(row.credentials, row.id));
  } catch {
    return null;
  }

  // Route dev-loop team traffic to the fake Gmail (fake-channels). Without this
  // the client would impersonate a mailbox that does not exist against a Google
  // that was never asked.
  const rawPayload =
    isTestHarnessTeam(input.teamId) && typeof payload === 'object' && payload !== null
      ? injectFakeBaseUrl({ ...payload }, 'GOOGLE_GMAIL')
      : payload;

  const parsed = gmailCredsParser.safeParse(rawPayload);
  if (!parsed.success) return null;

  const allowed = checkGmailMailboxAllowed(parsed.data.mailbox);
  if (!allowed.ok) {
    throw new Error(`GmailAdapter: ${allowed.message}`);
  }
  return new GmailApiClient(parsed.data);
}
