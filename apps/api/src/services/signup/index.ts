// Sign-in from a verified identity (Google, Microsoft) — create-on-invite.
//
// There is no self-serve signup on this branch: an address that is neither an
// existing account nor a pending invite is refused. `TeamInviteService`
// (`resolveSignInForVerifiedEmail`) owns that rule for every sign-in path; this
// module is the OAuth caller's side of it — the analytics, the ops note, and
// the shape the REST handler routes on.

import { recordSignupEvent, type SignupAttribution } from './attribution';
import { mq } from '../../lib/message_queue';
import { sendSlackNotification } from '../../lib/slack';
import { TeamInviteService } from '../team_invite';
import { UserService } from '../user';

export type SignupResult =
  | { ok: true; email: string; created: boolean; teamId: string }
  | { ok: false; reason: 'not_invited' };

/**
 * Sign a verified email in, joining whatever teams have written it down. New
 * accounts are provisioned onto the inviting team; an uninvited stranger is
 * refused. Returns the email on success; the REST caller mints the JWT + sets
 * the cookie.
 */
async function signupFromVerifiedEmail({
  email,
  name,
  source,
  attribution,
}: {
  email: string;
  /** Human display name from the OAuth profile. Stored on `user.name`. */
  name?: string | null;
  source?: string;
  attribution?: SignupAttribution;
}): Promise<SignupResult> {
  const resolution = await TeamInviteService.resolveSignInForVerifiedEmail({ email, name });
  if (resolution.status === 'not_invited') return { ok: false, reason: 'not_invited' };

  const { userId, teamId, email: lower, created } = resolution;
  if (!created) return { ok: true, email: lower, created: false, teamId };

  // Record the joining channel + marketing attribution for the admin app (new
  // accounts only). Best-effort.
  await recordSignupEvent({ email: lower, teamId, channel: source ?? 'oauth', attribution });

  // Fire the same downstream "user created" event the Prisma create path did
  // (analytics — the consumer reads `user.id`).
  const createdUser = await UserService.getById(userId);
  mq.users.created.publish(createdUser);

  await sendSlackNotification({
    type: 'ONBOARDING',
    teamId,
    text: `:tada: ${name ? `${name} (${lower})` : lower} joined team ${teamId}`,
    opsTitle: `${name ? `${name} (${lower})` : lower} joined a team`,
  }).catch(() => {});

  return { ok: true, email: lower, created: true, teamId };
}

export const SignupService = { signupFromVerifiedEmail };
