// The examples page — the one page an authoring agent reads in the `examples`
// handbook. Show rather than tell: a few whole programs, read top to bottom,
// whose comments carry what the lean front page says in prose (where a
// TypeScript habit misleads, and the ideas TypeScript has no word for).
// Lookups past it go through the language search, as in the lean handbook.
//
// Every program is a probe the tests hand to the real checker and the engine's
// interpretability scan, exactly as shown: the page cannot teach something that
// does not compile. A program that imports a function from a file by path
// carries that file, so the checker can resolve it.
//
// Plan: plans/functional-extract-2026-10-02/3_docs_and_evals.md (an
// examples-only handbook).

import type { EngineClaim } from './types';
import { BUILD_LOOP } from './front_page';

/** One addressable program: `examples#<anchor>` reads it alone. */
export interface ExampleProgram {
  anchor: string;
  title: string;
  /** Shown as is, and checked as is. */
  source: string;
  /** Files the program imports by path, keyed by that path. Checked, not shown. */
  files?: Readonly<Record<string, string>>;
}

const INTAKE_ROUTINES = `import { attio } from adapters
import { acme_main } from credentials

crm = attio(credentials: acme_main)

export node Lead {
  Name: <text>
  Email: <text>
}

export function \`Log Lead\`(lead: <Lead>) {
  write crm-[:People]-> { unique by (Email), Email: lead.Email, Name: lead.Name }
}
`;

export const EXAMPLE_PROGRAMS: readonly ExampleProgram[] = [
  {
    anchor: 'intake',
    title: 'An email becomes a CRM record',
    files: { 'lib/intake-routines': INTAKE_ROUTINES },
    source: `# This is a comment. No semicolons.
# The language is functional, with first-class mutable graphs:
# TypeScript's syntax meets Cypher's paths, live-typed against the systems you connect.
# A program runs when an event arrives.

# import brings in adapters (systems presented as graphs), credentials (auth, hidden
# from the program), plugins (functions the platform ships) and your own functions (by path)
import { email, attio } from adapters
import { acme_main } from credentials
import { \`Log Lead\`, Lead as \`Inbound Lead\` } from "lib/intake-routines"

# construct a system once, giving it its credentials
# "=" binds a name once: no let, no const
inbox = email()
crm   = attio(credentials: acme_main)

# backticks quote a name with spaces; they are never strings
# a type wears angle brackets: <text>, <number>, <inbox-[:Email]->> (an inbox email)
function \`Inbound Intake\`(msg: <inbox-[:Email]->>) {
  # a path walks a system, like Cypher; a write creates,
  # or updates the record with this Name, so a repeat never duplicates
  write crm-[:Companies]-> {
    unique by (Name)
    Name: msg.Subject
    # "…" and '…' interpolate \${…} and may span lines; + only adds numbers
    Description: "Wrote in from \${msg.From}"
  }

  # graph<Shape> { … } builds a record; values never change once built
  # function names ignore letter case
  \`log lead\`(graph<\`Inbound Lead\`> { Name: msg.From, Email: msg.From })
}

# "listen to … fire …" runs a function on each event
# an email listen needs a key: the address mail is sent to
listen to inbox { key: "intake" } fire \`Inbound Intake\``,
  },
  {
    anchor: 'extraction',
    title: 'A model reads an email, then each company is looked up',
    source: `import { email, attio } from adapters
import { acme_main } from credentials
import { fetch_url } from plugins

inbox = email()
crm   = attio(credentials: acme_main)

# a node declares a shape: a type, and a schema whose descriptions instruct the model
node Company: "a company this email introduces" {
  Name:    <text> "its name"
  Website: <text | null> "its website, if given"
}

node Profile: "the company" {
  Summary:   <text> "one line on what it does"
  Headcount: <number | null> "how many people work there"
}

function \`File Intros\`(msg: <inbox-[:Email]->>) {
  # extract returns a list, extractOne a record or absent
  # arguments go data first, then one settings record
  content   = [msg.Body, msg.Subject]
  companies = extract(content, Company, { tier: 'careful' })

  # no for or while: MAP calls the function per item
  found = MAP(companies, { initialConcurrency: 1, concurrency: 4, onError: 'warn' }, (c) => {
    # what may be missing is absent: no undefined, ?? or ?.
    page = IF c.Website == null THEN "" ELSE COALESCE(fetch_url(url: c.Website), "") END
    profile = extractOne([...content, c.Name, page], Profile)
    # a later field wins; an absent profile has absent fields
    return { ...c, ...profile }
  })

  MAP(found, (f) => {
    # IF … THEN … ELSE … END replaces ? :
    stage = IF f.Headcount != null AND f.Headcount > 50 THEN "scale-up" ELSE "early" END
    write crm-[:Companies]-> {
      # a strong key first, then a fuzzy name (lines are OR); a line with no key is skipped
      unique by (Domains)
      unique by (FUZZY Name)
      Name: f.Name
      Domains ?: f.Website
      Description: "\${stage}: \${COALESCE(f.Summary, 'no summary')}"
      # Field ?: value writes the field only when the value is there
      \`Team Size\` ?: f.Headcount
    }
  })
}

listen to inbox { key: "intros" } fire \`File Intros\``,
  },
  {
    anchor: 'approval',
    title: 'A person approves before anything leaves the team',
    source: `import { whatsapp, slack, ask } from adapters
import { team_chat } from credentials

wa   = whatsapp()
chat = slack(credentials: team_chat)
asks = ask()

function \`Answer Customer\`(msg: <wa-[:Message]->>) {
  draft = AI("a short, friendly reply to: \${msg.Body}")
  # an early exit narrows an absent value; ERROR fails the run (no throw, no try)
  if draft == null { ERROR("no reply drafted") }

  # ask a person first: write a question, post its link, await the answer
  q = write asks-[:Check]-> { Prompt: "Send this to \${msg.\`Profile Name\`}?", Detail: draft }
  general = ONLY(chat-[ch:Channels WHERE Name == "general"]->)
  if general == null { ERROR("no #general channel") }
  write general-[:Messages]-> { Message: "A reply needs approval: \${q.Url}" }

  # await starts a statement, never inside an expression; the run parks here
  answer = await FIRST(q-[:Response]->)
  if answer.Answer {
    write msg-[:Replies]-> { Body: draft }
  } else {
    write general-[:Messages]-> { Message: "Reply not sent." }
  }
}

listen to wa {} fire \`Answer Customer\``,
  },
];

function renderProgram(program: ExampleProgram): string {
  return `### ${program.anchor} — ${program.title}\n\n\`\`\`\n${program.source}\n\`\`\``;
}

/** The examples page, as the `examples` handbook serves it. */
export function renderExamplesPage(): string {
  return [
    '## Writing automations, by example',
    'Read top to bottom: the comments carry the rules.',
    ...EXAMPLE_PROGRAMS.map(renderProgram),
    BUILD_LOOP,
  ].join('\n\n');
}

/** One program by its anchor — `examples#approval` — or the build loop. */
export function examplesSection(anchor: string): { ok: true; content: string } | { ok: false; error: string } {
  const wanted = anchor.trim().toLowerCase();
  if (wanted === 'build-loop') return { ok: true, content: BUILD_LOOP };
  const program = EXAMPLE_PROGRAMS.find((p) => p.anchor === wanted);
  if (program) return { ok: true, content: renderProgram(program) };
  const anchors = [...EXAMPLE_PROGRAMS.map((p) => p.anchor), 'build-loop'];
  return { ok: false, error: `No section "${anchor}" on the examples page. Sections: ${anchors.join(', ')}.` };
}

/** The page's programs as claims the handbook's lockstep and checker tests hold. */
export function examplesPageClaims(): EngineClaim[] {
  return EXAMPLE_PROGRAMS.map((program) => ({
    construct: `examples page: ${program.anchor}`,
    status: 'runs' as const,
    probe: `${program.source}\n`,
    ...(program.files ? { files: program.files } : {}),
  }));
}
