// Which Gmail controls the connections modal shows.
//
// A deployment connects Gmail either by signing in as the mailbox or by naming
// a mailbox its Google service account already has access to. The server owns
// that decision and reports it through `gmailConnectPolicy`; the UI only
// renders what it is told, so the two can never disagree about which form to
// fill in.

export interface GmailConnectPolicy {
  method: 'oauth' | 'delegated';
  /** Whether this server can actually run a Google sign-in — it needs an OAuth
   *  client, and a deployment set to `oauth` may simply not have one yet. */
  signIn: boolean;
}

export interface GmailControls {
  /** The Google button. */
  signIn: boolean;
  /** Paste a refresh token the mailbox already granted — beside the button,
   *  for a Workspace admin who authorised the mailbox themselves. */
  refreshToken: boolean;
  /** Type a mailbox address, which only means anything where the deployment
   *  already holds the right to act as it. */
  mailbox: boolean;
}

const NOTHING: GmailControls = { signIn: false, refreshToken: false, mailbox: false };

export function gmailConnectControls(policy: GmailConnectPolicy | undefined): GmailControls {
  if (!policy) return NOTHING;
  if (policy.method === 'delegated') return { ...NOTHING, mailbox: true };
  // The paste redeems the token with the SAME OAuth client the button signs in
  // through, so the two stand or fall together: a deployment set to sign in
  // that registered no client can offer neither.
  return { signIn: policy.signIn, refreshToken: policy.signIn, mailbox: false };
}

export const GMAIL_UNAVAILABLE_NOTE =
  'Gmail is not set up on this server. An administrator has to register the ' +
  'Google integration client, or switch this installation to the delegated ' +
  'connect method.';
