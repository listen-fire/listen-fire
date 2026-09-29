// The system adapter's conceptual authoring documentation — assembled into the
// automation handbook as the `system:system` chapter, bound by the same prose
// contract as every hand-written chapter.

import type { HandbookSection } from '../../../../lib/handbook_section';

export const SYSTEM_HANDBOOK_SECTION: HandbookSection = {
  title: 'Platform events — when an automation fails (system)',
  content: `## Platform events — when an automation fails (system)

Use \`system()\` to run an automation when something happens to your other automations. Post a failure to Slack:

\`\`\`
import { system, slack } from adapters
import { team_workspace } from credentials

sys  = system()
team = slack(credentials: team_workspace)

function \`Report Failure\`(failed: <sys-[:\`Run Failed\`]->>) {
  alerts = ONLY(team-[ch:Channels WHERE \`Name\` == "alerts"]->)
  if alerts == null { ERROR("no #alerts channel") }
  write alerts-[:Messages]-> {
    Message: "\${failed.\`Automation\`} failed: \${failed.\`Reason\`} \${failed.\`Url\`}"
  }
}

listen as "Report failures" to sys { events: ["Run Failed"] } fire \`Report Failure\`
\`\`\`

- Every event carries \`Automation\`, \`Automation Id\`, \`Run Id\`, \`Version\`, \`Reason\`, \`Url\` (a link to the automation's failed runs) and \`At\`.
- \`Run Failed\` arrives within a couple of minutes of a run ending failed, once per run. An automation is never told about its own failures, and a rehearsal failing is not reported.
- \`Validation Issue\`, \`Deprecated Version\` and \`Release Applied\` are declared but emitted by the deploy check from the next release; a listen on them fires nothing yet.
- Going live never replays earlier failures: the first look sets the mark.`,
  engineClaims: [
    {
      construct: 'system-channel listeners (runs over the Run Failed position)',
      status: 'runs',
      probe: `
import { system, slack } from adapters
import { team_workspace } from credentials

sys  = system()
team = slack(credentials: team_workspace)

function \`Report Failure\`(failed: <sys-[:\`Run Failed\`]->>) {
  alerts = ONLY(team-[ch:Channels WHERE \`Name\` == "alerts"]->)
  if alerts == null { ERROR("no #alerts channel") }
  write alerts-[:Messages]-> {
    Message: "\${failed.\`Automation\`} failed: \${failed.\`Reason\`} \${failed.\`Url\`}"
  }
}

listen as "Report failures" to sys { events: ["Run Failed"] } fire \`Report Failure\`
`,
    },
  ],
};
