// `@lf/system`'s authoring documentation: the handbook's section on the
// host's own events.

import type { HandbookSection } from 'movement-engine/public/handbook';

export const SYSTEM_HANDBOOK_SECTION: HandbookSection = {
  title: 'The host’s own events (system)',
  content: `## The host’s own events (system)

\`@lf/system\` runs a program when something happens to your other programs: a run failed, or a wait lost its record. Post each failure to Slack:

\`\`\`
sys  = connect system
team = connect slack using team_workspace

function report(e: <sys-[:Events]->>) {
  alerts = only(team-[ch:Channels WHERE ch.Name == "alerts"]->)
  if (alerts == null) { fail("no #alerts channel") }
  write alerts-[:Messages]-> { Message: "\${e.Automation} failed: \${e.Reason}" }
}

listen to sys-[e:Events WHERE e.Kind == "Run Failed"]-> fire report
\`\`\`

- Every event carries \`Kind\`, \`Event Id\`, \`Automation\`, \`Automation Id\`, \`Run Id\`, \`Version\`, \`Reason\`, \`Url\` and \`At\`. A wait that lost its record also carries \`Adapter\`, \`Edge\` and \`Record Id\`; an arrival not judged carries \`Edge\`, \`Record Id\`, \`Listen\`, \`Delivery Id\`, \`Arrival Id\` and \`Attempt\`.
- Name the kinds a listen wants with \`e.Kind == "…"\` or \`e.Kind IN [...]\`: \`Run Failed\`, \`Run Paused\`, \`Wait Lost Its Record\`, \`Arrival Not Judged\`, \`Release Applied\`, \`Validation Issue\`, \`Deprecated Version\`.
- \`Arrival Not Judged\`: a listen could not tell whether something that arrived fires it, because its WHERE reads a field the system could not give (a lookup it did not answer). That listen ran nothing; the arrival's other listens ran. It is reported once per listen and arrival, and once more for each replay that still cannot judge it (\`listen-fire listens replay\`).
- A program is never told about its own listen's failures or waits, and a rehearsal failing is not reported.
- Events are polled, every minute by default: one arrives a minute or so after it happened. Going live never replays earlier events.
- A handler that fails on another program's failures, which fails in turn, is a chain the host pauses at its loop depth (\`loopDepth\` in lf.yaml).
- A wait whose record was deleted never ends: race it with a \`sleep\`, and listen for \`Wait Lost Its Record\` to hear of the ones that were not.
- listen-fire reports \`Run Failed\`, \`Wait Lost Its Record\`, \`Arrival Not Judged\` and \`Release Applied\`. It fails a run at its cost cap rather than pausing it, and refuses a program that does not check, so it never reports the other three.`,
};
