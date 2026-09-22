// `external_service_credentials.app_id` — which app/bot in an external service a
// credential grants access through. A stable Listen-Fire-side shorthand (the real
// external ids live in env; we branch our own code on this), so a second app of
// the same ExternalServiceType can be told apart and filtered without decrypting
// the credential.

/** The Slack apps we distinguish. */
export const SLACK_APP_ID = {
  /** The legacy Slack app — knowledge pipeline, ops feed, monitoring. */
  legacy: 'legacy',
  /** The new "Listen-Fire" Slack app that runs movements. */
  movements: 'listen-fire',
} as const;

export type SlackAppId = (typeof SLACK_APP_ID)[keyof typeof SLACK_APP_ID];

/**
 * The two Gmail credential SHAPES that share `GOOGLE_GMAIL`.
 *
 * The retired per-user sign-in stored an OAuth token for one person's mail and
 * nothing ever read it; the connector stores a mailbox address the deployment's
 * service account acts as. They are told apart here rather than by decrypting
 * and guessing at the payload — a row from the old flow is dead, and must read
 * as dead before anything tries to use it as a mailbox.
 */
export const GMAIL_APP_ID = {
  /** The retired per-user OAuth sign-in. Pre-discriminator rows are null and
   *  read as this, which is right: they all came from that flow. */
  legacySignIn: 'gmail-oauth',
  /** The connector: one mailbox, reached by domain wide delegation. */
  delegatedMailbox: 'gmail-delegated',
} as const;

export type GmailAppId = (typeof GMAIL_APP_ID)[keyof typeof GMAIL_APP_ID];

/** Whether a `GOOGLE_GMAIL` credential is a connector mailbox rather than a
 *  dead row from the retired sign-in. */
export function isDelegatedGmail(appId: string | null | undefined): boolean {
  return appId === GMAIL_APP_ID.delegatedMailbox;
}

/**
 * Whether a credential belongs to the LEGACY app — explicitly `legacy`, or
 * pre-discriminator (`null`, from before this column existed). Legacy pipelines
 * filter on this; modern (movements) paths require `app_id === 'listen-fire'`.
 */
export function isLegacyApp(appId: string | null | undefined): boolean {
  return appId == null || appId === SLACK_APP_ID.legacy;
}

/**
 * The `app_id` a freshly-minted credential of `type` gets by default. Slack:
 * `listen-fire` — the modern connect flow IS the Listen-Fire app (Option A), so every new
 * Slack credential belongs to it; pre-existing legacy rows keep their `null`
 * (read as legacy). Gmail: the delegated mailbox — the only flow that mints one
 * now. Other services: undefined (no second app to distinguish).
 */
export function defaultAppIdForType(type: string): string | undefined {
  if (type === 'SLACK') return SLACK_APP_ID.movements;
  if (type === 'GOOGLE_GMAIL') return GMAIL_APP_ID.delegatedMailbox;
  return undefined;
}
