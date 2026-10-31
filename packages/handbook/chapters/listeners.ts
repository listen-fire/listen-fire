import type { Chapter } from '../types';

export const listeners: Chapter = {
  id: 'listeners',
  title: 'Listeners — how an automation is triggered',
  content: `## Listeners — how an automation is triggered

Use \`listen\` to say when an automation runs. Everything that starts a run — a live event, a schedule, a person clicking "Run now" — arrives through a \`listen\` line.

### listen

\`\`\`
inbox = connect email
…
listen as "Deal intake" to inbox-[e:Emails WHERE e.Key == "deals"]-> fire \`Intake\`
\`\`\`

- You listen to a traversal from the instance (\`inbox\`), never the adapter, ending on the edge its events arrive on (\`-[e:Emails]->\`).
- \`as "…"\` names the listener in run history and lists. Two listeners firing the same automation need distinct names.
- A hop's \`WHERE\` says which arrivals are passed through. An edge every team's events arrive on (an inbox's \`Emails\`, a schedule's \`Ticks\`) needs one: the system's chapter says which field narrows it.
- A system that is polled rather than pushed (Granola, Gmail) checks on its own interval; \`every: 5m\` in the block sets how often this listener looks (\`listen to notes { every: 5m } fire summarise\`).
- \`fire\` names the automation that runs; its parameter is the event, typed to the same instance (\`function intake(m: <inbox-[:Emails]->>)\`).

Saving the file registers its listeners; if one can't go live, the save says so. Schedules come from the \`cron\` system, and ad-hoc runs — "Run now", pasted text, uploaded files — from \`manual\`; each has its own chapter.

### inbound-mail

\`connect email\` is inbound mail. Which carrier delivers it is a setting of the deployment, not a choice an automation makes.`,
  engineClaims: [
    {
      construct: 'listen as "…" — two aliased lanes on one channel firing one movement',
      status: 'runs',
      probe: `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

function \`Intake\`(m: <inbox-[:Emails]->>) {
  write crm-[:Companies]-> {
    unique by (FUZZY Name)
    Name: m.Subject
  }
}

listen as "Deal intake"  to inbox-[e:Emails WHERE e.Key == "deals"]->  fire \`Intake\`
listen as "Intro intake" to inbox-[e:Emails WHERE e.Key == "intros"]-> fire \`Intake\`
`,
    },
    {
      construct: 'suppress_self on a listener (opt-in two-way-sync echo suppression)',
      status: 'runs',
      probe: `
import { \`@lf/attio\` as attio } from adapters
import { acme } from credentials

crm = connect attio using acme

function \`Mirror Company\`(ev: <crm-[:\`Webhook Event\`]->>) {
  if (ev is <crm-[e:\`Webhook Event\` WHERE e.action == "record.updated"]->>) {
    ev-[rec:Companies]-> {
      write crm-[:Companies]-> {
        unique by (Name)
        Name: rec.Name
      }
    }
  }
}

listen to crm { suppress_self: true } fire \`Mirror Company\`
`,
    },
  ],
};
