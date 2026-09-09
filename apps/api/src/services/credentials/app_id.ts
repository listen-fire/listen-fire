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
 * (read as legacy). Other services: undefined (no second app to distinguish).
 */
export function defaultAppIdForType(type: string): string | undefined {
  return type === 'SLACK' ? SLACK_APP_ID.movements : undefined;
}
