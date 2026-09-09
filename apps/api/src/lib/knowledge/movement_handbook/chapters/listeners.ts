import type { Chapter } from '../types';

export const listeners: Chapter = {
  id: 'listeners',
  title: 'Listeners — how an automation is triggered',
  content: `## Listeners — how an automation is triggered

Use \`listen\` to say when an automation runs. Everything that starts a run — a live event, a schedule, a person clicking "Run now" — arrives through a \`listen\` line.

### listen

\`\`\`
inbox = email()
…
listen as "Deal intake" to inbox { key: "deals" } fire \`Intake\`
\`\`\`

- You listen to the instance (\`inbox\`), never the adapter.
- \`as "…"\` names the listener in run history and lists. Two listeners firing the same automation need distinct names.
- The \`{ … }\` block is **trigger configuration** — it defines which events are passed through, and differs by system. Its keys are the system's own (a routing key, an \`events\` list of change kinds); the system's chapter says what it offers.
- \`fire\` names the automation that runs; its parameter is the event, typed to the same instance (\`intake(m: <inbox-[:Email]->>)\`).

Saving the file registers its listeners; if one can't go live, the save says so. Schedules come from the \`cron\` system, and ad-hoc runs — "Run now", pasted text, uploaded files — from \`manual\`; each has its own chapter.

### Naming the mail carrier

\`email()\` is the neutral name for inbound mail. \`mailgun()\` and \`resend()\` are the same thing said more specifically — same fields, same attachments, same trigger configuration — and which one a deployment actually runs through is a setting, not a choice an automation makes. Write \`email()\` unless you have a reason to record the carrier. If both are set up, mail comes in through Resend.`,
  engineClaims: [
    {
      construct: 'listen as "…" — two aliased lanes on one channel firing one movement',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    unique by (FUZZY \`Name\`)
    Name: m.\`Subject\`
  }
}

listen as "Deal intake"  to inbox { key: "deals" }  fire \`Intake\`
listen as "Intro intake" to inbox { key: "intros" } fire \`Intake\`
`,
    },
    {
      construct: 'suppress_self on a listener (opt-in two-way-sync echo suppression)',
      status: 'runs',
      probe: `
import { attio } from adapters
import { acme } from credentials

crm = attio(credentials: acme)

function \`Mirror Company\`(ev: <crm-[:\`Webhook Event\`]->>) {
  if ev IS <crm-[:\`Webhook Event\` WHERE \`action\` == "record.updated"]->> {
    ev-[rec:Companies]-> {
      write crm-[:Companies]-> {
        unique by (\`Name\`)
        Name: rec.\`Name\`
      }
    }
  }
}

listen to crm { suppress_self: true } fire \`Mirror Company\`
`,
    },
  ],
};
