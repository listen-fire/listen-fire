import type { Chapter } from '../types';

export const listeners: Chapter = {
  id: 'listeners',
  title: 'Listeners — how an automation is triggered',
  content: `## Listeners — how an automation is triggered

Use \`listen\` to say when an automation runs. Everything that starts a run — a live event, a schedule's tick, a person clicking "Run now" — arrives through a \`listen\` line.

### listen

\`\`\`
inbox = connect \`@lf/email\`
…
listen as "Deal intake" to inbox-[e:Emails WHERE e.Key == "deals"]-> fire \`Intake\`
\`\`\`

- A listen is a traversal from a connection (\`inbox\`), never the adapter, ending on an edge its system announces arrivals on (\`-[e:Emails]->\`). Each system's chapter names those edges.
- \`fire\` names the function that runs, once per arrival. Its parameter is typed by what lands, addressed from the connection: the edge (\`function intake(m: <inbox-[:Emails]->>)\`) or the record type (\`<chat-[:Interaction]->>\`).
- \`as "…"\` names the listener in run history and lists. Two listeners firing the same automation need distinct names.
- Schedules are \`cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1-5" AND t.Zone == "Europe/London"]->\`, and ad-hoc runs — "Run now", pasted text, uploaded files — are \`manual-[:Invocations]->\`; each has its own chapter.

Saving the file registers its listeners; if one can't go live, the save says so.

### where-a-filter-is-judged

A listen may filter any hop: \`chat-[ch:Channels WHERE ch.Name == "deals"]->-[m:Messages WHERE m.Message CONTAINS "intro"]->\`. A \`WHERE\` reads only its own hops and literals — never a name a run holds, \`ai(…)\`, or another walk. Each part of it is judged in one of three places:

- **By the system**, which sends only what matches, as it does for a read.
- **On arrival**, against the record that landed and the records it carries: a Slack message carries its channel, a press its channel and message. Each system's chapter says what its arrivals carry.
- **By listing**, for an earlier hop the arrival does not carry: the host lists the records that match and watches only those. It lists them again on the system's cadence (on a change the system reports, or on an interval its chapter states). Between two listings, a record renamed out of the filter still fires, and one renamed in does not yet.

A filter on a hop that arrivals do not carry and that is not cheap to list is refused when you save, with the way out: filter on what arrives, or wait on one record in a run.

\`listen-fire listens\` shows each listen: how each hop's filter is honoured (\`arrival\`, \`resolved\`, \`unfiltered\`), what it watches, and whether it is ok or paused.

### edges-that-need-a-filter

Some edges span far more than one listen should hear: every schedule (\`Ticks\`), every team's mail (\`Emails\`). A listen on one names the values it wants on the field the system narrows it by, with \`==\` or \`IN [ … ]\` and literals: \`t.Schedule == "0 9 * * 1"\`, \`e.Key == "deals"\`. Without that the save is refused, showing the filter to write.

### shared-polls

Listens on one connection and edge with the same filter share one poll or one webhook. A polled system (Granola, Gmail) is polled at the interval its edge declares; a deployment sets another per connection (\`pollEvery\` in \`lf.yaml\`), and a listen sets none.

### loops

A run's writes can fire more runs: a two-way sync hears its own write come back, and two automations can feed each other. The host breaks every loop:

- An arrival on a record a run wrote shortly before (\`loopWindow\` in \`lf.yaml\`, 20 seconds by default) continues that run's chain.
- The listen whose arrival would make a chain longer than \`loopDepth\` runs (10 by default) is paused, by name. While paused, its arrivals are counted and not run; \`listen-fire listens resume <file>:<movement>\` lets it fire again, and the held arrivals stay unrun.
- A write that would change nothing is not sent where the system reads the record back, so a sync's echo writes nothing and its chain ends.

Filter a sync's listen to the fields it copies (\`c.Field == "Name"\`), so its other writes never fire it.

### an-arrival-not-judged

A listen that cannot tell whether an arrival fires it — its filter reads a field the system could not give — runs nothing for it, while the arrival's other listens run as usual. The host reports it on the system's \`Events\` as \`Arrival Not Judged\`, with the listen and the delivery:

\`\`\`
listen to sys-[e:Events WHERE e.Kind == "Arrival Not Judged"]-> fire \`Report Unjudged\`
\`\`\`

Once the system answers again, \`listen-fire listens replay <file>:<movement> --delivery <id>\` puts that delivery through that listen alone. A listen that ran the arrival before runs nothing; \`--force\` runs it again.

### waiting-in-a-fired-run

- \`await new x-[:E]->\` counts from when \`x\` entered the run. The record that started the run, and each record its arrival carried, entered at delivery; a record the run steps to entered at that step. The arrival that started the run never answers it.
- Race every wait on a person or a system with a \`sleep\`: a record deleted while a run waits on it leaves the wait waiting.
- \`listen to sys-[e:Events WHERE e.Kind == "Wait Lost Its Record"]-> fire …\` hears each wait whose record was deleted.

### inbound-mail

\`\`connect \`@lf/email\` \`\` is inbound mail. Which carrier delivers it is a setting of the deployment, not a choice an automation makes.`,
  engineClaims: [
    {
      construct: 'listen as "…" — two aliased lanes on one channel firing one movement',
      status: 'runs',
      probe: `
inbox = connect \`@lf/email\`
crm   = connect \`@lf/attio\` using acme

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
      construct: 'a two-way sync whose listen takes only the fields it reads, so its own write does not run it again',
      status: 'runs',
      probe: `
crm = connect \`@lf/attio\` using acme

function \`Mirror Company\`(c: <crm-[:CompanyChange]->>) {
  c-[rec:Company]-> {
    write crm-[:Companies]-> {
      unique by (Name)
      Name: rec.Name
      Description: "Mirrored"
    }
  }
}

listen to crm-[:Companies]->-[c:Changes WHERE c.Field == "Name"]-> fire \`Mirror Company\`
`,
    },
  ],
};
