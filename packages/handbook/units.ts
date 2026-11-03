// The chapters on the run host's units, `cron` and `manual`: names every
// program has in scope, connected, with no import (the language's
// RUN_HOST_UNITS). They are the language's, not a module's, so their chapters
// are here rather than in a manifest; a host adds them to its book as it adds
// its modules' sections (`system:<name>`), and a host's own chapter of the
// same id takes their place.

import type { Chapter, SystemChapterId } from './types';

const cron: Chapter = {
  id: 'system:cron',
  title: 'Schedules: runs at set times (cron)',
  content: `## Schedules: runs at set times (cron)

Listen to \`cron\`'s \`Ticks\` to run on a schedule. \`cron\` is always there: no import, no \`connect\`.

\`\`\`
chat = connect \`@lf/slack\` using team_chat

function \`Weekly Digest\`(t: <cron-[:Ticks]->>) {
  ops = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
  if (ops == null) { fail("no #general channel") }
  write ops-[:Messages]-> { Message: "Digest for \${t.\`Fired at\`}" }
}

listen as "Weekly digest" to cron-[t:Ticks WHERE t.Schedule == "0 9 * * 1" AND t.Zone == "Europe/London"]-> fire \`Weekly Digest\`
\`\`\`

- \`Schedule\` is required: five-field cron. \`"0 9 * * 1"\` is 09:00 every Monday. \`t.Schedule IN ["0 9 * * 1", "0 9 * * 4"]\` names several.
- \`Zone\` is an IANA name (\`"Europe/London"\`), read with daylight saving. A listen that names no zone is read in UTC.
- A \`Tick\` carries \`Fired at\` (the instant it was due), \`Schedule\` and \`Zone\`. The tick says only when: what the run reports on, it reads (\`patterns#scheduled-digest\`).
- Occurrences missed while nothing was running fire once, as the latest of them. A new listen waits for its next occurrence; it never fires for one already past.`,
  engineClaims: [
    {
      construct: 'a schedule listen in a zone, reading its tick',
      status: 'runs',
      probe: `
chat = connect \`@lf/slack\` using team_chat

function \`Weekly Digest\`(t: <cron-[:Ticks]->>) {
  ops = only(chat-[ch:Channels WHERE ch.Name == "general"]->)
  if (ops == null) { fail("no #general channel") }
  write ops-[:Messages]-> { Message: "Digest for \${t.\`Fired at\`}" }
}

listen to cron-[t:Ticks WHERE t.Schedule IN ["0 9 * * 1", "0 9 * * 4"] AND t.Zone == "Europe/London"]-> fire \`Weekly Digest\`
`,
    },
  ],
};

const manual: Chapter = {
  id: 'system:manual',
  title: 'Run now: runs started by hand, with text (manual)',
  content: `## Run now: runs started by hand, with text (manual)

Listen to \`manual\`'s \`Invocations\` to let a person, or an agent, start a run by hand. \`manual\` is always there: no import, no \`connect\`. Each start is one \`Invocation\`, and any text supplied with it is its \`Text\`:

\`\`\`
crm = connect \`@lf/attio\` using acme

node Company: "each company named in the supplied text" {
  name:   <text> "the company's name"
  domain: <text> "the company's web domain, if given"
}

function \`Import Companies\`(go: <manual-[:Invocations]->>) {
  found = extract([go.Text], Company)

  map(found, (c) => {
    write crm-[:Companies]-> {
      unique by (FUZZY Name)
      Name:    c.name
      Domains: c.domain
    }
  })
}

listen as "Import companies" to manual-[:Invocations]-> fire \`Import Companies\`
\`\`\`

- Only \`Fired at\` is always there. \`Text\`, \`Run by (email)\` and \`Run by (name)\` may be absent: a bare start has no text.
- A host that takes files with a start puts each on the invocation's \`Files\` edge, a \`File\` with its \`Name\`, \`Content Type\` and \`Size\`.
- A backfill is this same listen with the source walked in the body: \`crm-[c:Companies]-> { … }\` runs the block once per existing record.`,
  engineClaims: [
    {
      construct: 'a manual start reading its text',
      status: 'runs',
      probe: `
crm = connect \`@lf/attio\` using acme

node Company: "each company named in the supplied text" {
  name:   <text> "the company's name"
  domain: <text> "the company's web domain, if given"
}

function \`Import Companies\`(go: <manual-[:Invocations]->>) {
  found = extract([go.Text], Company)

  map(found, (c) => {
    write crm-[:Companies]-> {
      unique by (FUZZY Name)
      Name:    c.name
      Domains: c.domain
    }
  })
}

listen to manual-[:Invocations]-> fire \`Import Companies\`
`,
    },
    {
      construct: 'a manual backfill walking the source in the body',
      status: 'runs',
      probe: `
crm = connect \`@lf/attio\` using acme

function \`Nightly Backfill\`(go: <manual-[:Invocations]->>) {
  crm-[c:Companies]-> {
    write c { Categories: "Reviewed" }
  }
}

listen to manual-[:Invocations]-> fire \`Nightly Backfill\`
`,
    },
  ],
};

/** The units' chapters, by the id the index and the catalog text route to. */
export const UNIT_CHAPTERS: Readonly<Record<SystemChapterId, Chapter>> = {
  'system:cron': cron,
  'system:manual': manual,
};
