// `@lf/system`'s authoring documentation: the handbook's section on the
// host's own events.

import type { HandbookSection } from 'movement-engine/public/handbook';

export const SYSTEM_HANDBOOK_SECTION: HandbookSection = {
  title: 'The host’s own events (system)',
  content: `## The host’s own events (system)

\`@lf/system\` runs a program when something happens to your other programs, or to the host running them: a run failed, or a wait lost its record. Post each failure to Slack:

\`\`\`
sys  = connect \`@lf/system\`
team = connect \`@lf/slack\` using team_workspace

function report(e: <sys-[:Events]->>) {
  alerts = only(team-[ch:Channels WHERE ch.Name == "alerts"]->)
  if (alerts == null) { fail("no #alerts channel") }
  write alerts-[:Messages]-> { Message: "\${e.Automation} failed: \${e.Reason}" }
}

listen to sys-[e:Events WHERE e.Kind == "Run Failed"]-> fire report
\`\`\`

- Every event carries \`Kind\`, \`Event Id\`, \`Automation\`, \`Automation Id\`, \`Run Id\`, \`Version\`, \`Reason\`, \`Url\` and \`At\`. A wait that lost its record also carries \`Adapter\`, \`Edge\` and \`Record Id\`; an arrival not judged carries \`Edge\`, \`Record Id\`, \`Listen\`, \`Delivery Id\`, \`Arrival Id\` and \`Attempt\`.
- Name the kinds a listen wants with \`e.Kind == "…"\` or \`e.Kind IN [...]\`.
- Kinds:
  - \`Run Failed\`: a run of another program ended failed.
  - \`Run Paused\`: a run paused at its cost limit and waits to be resumed.
  - \`Wait Lost Its Record\`: a run waits on a record that was deleted.
  - \`Arrival Not Judged\`: a listen could not tell whether an arrival fires it, because its WHERE reads a field the system could not give (a lookup it did not answer). That listen ran nothing; the arrival's other listens ran. It is reported once per listen and arrival, and once more for each replay that still cannot judge it.
  - \`Release Applied\`: a new release is running.
  - \`Validation Issue\`: a saved program does not validate under the running release.
  - \`Deprecated Version\`: a saved program is pinned to a deprecated language version; it still runs.
- Which kinds arrive depends on the host running the program: a host reports a kind only if it supplies the facts for it. A listen on a kind the host does not report never fires.
- A program is never told about its own listen's failures or waits, and a rehearsal failing is not reported.
- Events are polled: one arrives a little after it happened. Going live never replays earlier events.
- A handler that fails on another program's failures, which fails in turn, is a chain the host pauses at its loop depth.
- A wait whose record was deleted never ends: race it with a \`sleep\`, and listen for \`Wait Lost Its Record\` to hear of the ones that were not.`,
};
