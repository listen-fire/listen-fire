// The names this deployment goes by. The product name is fixed; the names a
// THIRD PARTY renders — a Slack app in a workspace, the app name Meta
// substitutes into a WhatsApp template — belong to whoever registered that app,
// so a self-hoster overrides them rather than shipping ours.

const PRODUCT_NAME = 'Listen-Fire';

/** The Slack app's display name, as a workspace sees it. */
function slackAppDisplayName(): string {
  return process.env.SLACK_APP_DISPLAY_NAME || PRODUCT_NAME;
}

/** The app name Meta renders into the WhatsApp authentication template. */
function whatsappAppDisplayName(): string {
  return process.env.WHATSAPP_APP_DISPLAY_NAME || PRODUCT_NAME;
}

/**
 * Where to send someone with a problem this deployment has to answer. Unset
 * means the deployment publishes no address — say nothing rather than invent
 * one, so nobody is directed at an inbox that will not read them.
 */
function supportEmail(): string | undefined {
  return process.env.SUPPORT_EMAIL || undefined;
}

export { PRODUCT_NAME, slackAppDisplayName, whatsappAppDisplayName, supportEmail };
