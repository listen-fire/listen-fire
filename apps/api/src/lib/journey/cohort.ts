/** The funnel describes only subjects created at or after instrumentation went
 *  live — a pre-launch user/team stamps later milestones with no earlier ones,
 *  which would render a NEGATIVE drop-off. MUST be >= the production deploy time
 *  of this feature, not the code-write time: erring late is safe (fewer, fully
 *  instrumented subjects), erring early is misleading. Confirm at release.
 *
 *  `user.created_at` / `team.created_at` are `timestamp WITHOUT time zone`, so
 *  this comparison is process-local wall-clock, not a UTC instant — despite
 *  the `Z` suffix in the literal below. Node's and Postgres's configured TZ
 *  must agree for the cutoff to mean what it says; under Europe/London in
 *  July (BST, UTC+1) this value lands at 01:00 local. Whoever sets this at
 *  release should confirm the running Postgres server's `TimeZone` setting,
 *  not just Node's, before trusting the literal at face value.
 *
 *  Also gates the ops-feed EMIT on a milestone transition (see
 *  `recordUserMilestone` / `recordTeamMilestone`): the milestone RECORD means
 *  "the first we observed"; the feed EVENT claims "their first, ever" — which
 *  is only true for subjects watched since signup. A pre-launch subject's
 *  first real activity after deploy is recorded silently; only a subject
 *  created at or after this cutoff gets announced. */
export const JOURNEY_LAUNCH_AT = new Date('2026-07-17T00:00:00Z');
