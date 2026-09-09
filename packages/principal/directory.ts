// The Directory contract — the second half of the identity world a product may
// import (D16, reshaped by D22 then D28). Read-only, and every lookup is
// TEAM-SCOPED: the WhatsApp check (D28) showed a flat global lookup either
// fails routing or silently admits an ungranted user, because it can answer
// neither "which team?" nor "may they act?".
//
// There are deliberately no phone lookups: the phone family is automations-
// owned (core plan C-5), and a product reads its own tables directly rather
// than taking a Directory hop for data it owns.

/** `hasAccess` = the subject is a member of the team AND their account is
 *  activated. A caller that ignores it is admitting ungranted users. */
interface DirectoryUser {
  id: string;
  email?: string;
  displayName?: string;
  hasAccess: boolean;
}

/** One membership-verified tie between a login email and a team. Deliberately
 *  bare: it says who and where, and nothing about whether they may act. */
interface DirectoryTeamAssociation {
  teamId: string;
  userId: string;
}

interface Directory {
  userById(q: { id: string; teamId: string }): Promise<DirectoryUser | null>;
  userByEmail(q: { email: string; teamId: string }): Promise<DirectoryUser | null>;
  members(teamId: string): Promise<DirectoryUser[]>;
  team(id: string): Promise<{ id: string; name: string } | null>;
  /**
   * The teams a login email is associated with — the ONE deliberate
   * global-scope lookup in this contract (D32).
   *
   * It exists because a channel door has no team until something resolves one:
   * an inbound email arrives addressed to a per-team routing key, and the
   * SENDER is what disambiguates which team's key was meant. Login emails are
   * core-owned data, so the resolution belongs here rather than in a product's
   * own copy of core's identity tables.
   *
   * It returns associations and never gates: membership is verified (an email
   * whose owner belongs to no team resolves to nothing), but admission is the
   * caller's policy — apply `userById`/`userByEmail`'s `hasAccess` per
   * candidate team before acting on one. Returning an empty array is the
   * honest answer for an unknown sender; it is not an error.
   */
  teamsForEmail(email: string): Promise<DirectoryTeamAssociation[]>;
}

export { type DirectoryUser, type DirectoryTeamAssociation, type Directory };
