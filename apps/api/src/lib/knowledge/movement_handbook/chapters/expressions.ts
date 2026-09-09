import type { Chapter } from '../types';

export const expressions: Chapter = {
  id: 'expressions',
  title: 'Expressions — reading, combining, and generating values',
  content: `## Expressions — reading, combining, and generating values

Everywhere an automation needs a value — a write field, an \`if\` condition, an item in an extraction's data list — it uses the same expression grammar. To choose between two values inside one, use \`IF <cond> THEN <a> ELSE <b> END\`; the lowercase statement \`if\` branches whole statements instead, and has its own chapter.

### interpolation

\`\`\`
Message: "New enquiry from \${msg-[:Sender]->.\`Name\`}:
  \${company.url}"
\`\`\`

Double-quoted strings span newlines and interpolate with \`\${…}\`. Whenever you are composing prose a person will read, write it as a template rather than as a \`CONCAT\` — the template shows the paragraphs it produces.

### ai

\`\`\`
Name: AI("the company name this email is about.
  Prefer the legal entity name over the brand name;
  ignore the sender's own firm.

  The email:
  Subject: \${msg.\`Subject\`}
  \${msg.\`Body\`}")
\`\`\`

\`AI("…")\` computes one value from an instruction in plain prose. **The model sees only your prompt** — not the triggering event, not the message body, nothing else from the run — so interpolate in the content the judgement needs. A prompt with no interpolated content is answered blind, and that is the usual cause of an \`AI()\` value that comes back empty or generic. For several records with several fields each, declare an \`extract\` tree instead: one pass rather than many independent calls.

A second argument says how much thinking the answer is worth. Three tiers, and nothing else to choose:

- \`"quick"\` — fast and cheap. Right for reformatting, tidying and classification: work where the answer is already in the prompt and only has to be picked out or restated.
- \`"careful"\` — a solid general answer. Right when the judgement is real but not hard.
- \`"thorough"\` — slow and expensive, and it genuinely reasons. Worth it for ranking, weighing trade-offs, or working something out over a long input; wasted on anything else.

Leave it off and you get \`"quick"\`. Nothing here names a model: which one answers, and how long it may take over the answer, is ours to keep current, and it changes without your automation changing.

\`\`\`
Category: AI("one of: bug, feature, question — for: \${msg.\`Subject\`}")
Summary:  AI(\`Digest Prompt\`, "careful")
Ranking:  AI("rank these by how well each fits the thesis: \${\`Candidates\`}", "thorough")
\`\`\`

Long prompts read best bound once at file scope under a name of their own, then passed by that name where the call needs them.

\`AI()\` may decide **nothing applies**, and then resolves to a real null rather than placeholder text like "none" or "N/A". Write the prompt so that no answer is a legitimate outcome ("only if…", "if any"), and gate on the result:

\`\`\`
\`Suggested Action\` = AI("a brief, actionable next step — only if one is
  genuinely needed — suggested by this email: \${msg.bodyText}")
if EXISTS(\`Suggested Action\`) {
  team-[ch:Channels WHERE \`Name\` == "follow-ups"]-> {
    write ch-[:Messages]-> { Message: \`Suggested Action\` }
  }
}
\`\`\`

### meta-fields

\`\`\`
write crm-[:Companies]-> {
  Name:          msg.\`Subject\`
  Description ?: "Owner: \${@user_email} — forwarded in by \${@actor_name} on \${@current_date}"
}
\`\`\`

Values that come from the run itself rather than from any record wear an \`@\` prefix and read like any other value, anywhere an expression can appear. There are eight, in three groups:

- \`@current_date\` (\`"2026-03-12"\`) and \`@current_timestamp\`, the moment the run fires, in UTC — \`Deadline: DATE.ADD_DAYS(@current_date, 14)\`. Every clock reading in a run gives that same moment, however long the run takes. For the date somewhere in particular, reach for \`DATE.TODAY(zone)\`.
- \`@user_email\`, \`@user_name\`, \`@user_id\` — the workspace member the run acts *on behalf of*. Forwarders are followed back to the real person: a message forwarded in by a teammate still names the original sender, the person whose work this is.
- \`@actor_email\`, \`@actor_name\`, \`@actor_id\` — whoever literally triggered the event in the source system, exactly as it reported them, member or not.

The two agree until a forward, relay, or service account sits between the originator and the responsible person. A meta-field the run can't resolve — an event that maps to no workspace member, a source that reports no sender — is simply empty, never an error.

### aggregates

\`\`\`
n       = COUNT(co-[t:Team]->)
owner   = ONLY(co-[t:Team WHERE \`Role\` == "Owner"]->)
newest  = FIRST(crm-[c:Companies ORDER BY \`Created At\` DESC]->.\`Name\`)
thread  = JOIN(ch-[m:Messages LIMIT 20]->.\`Text\`, "\n")
roster  = JOIN(SORT(co-[t:Team]->.\`Name\`), ", ")
\`\`\`

An aggregate reads a whole traversal (or a bound block's list) and answers one value. Which ones you may reach for depends on whether what you are reading has an order.

- \`COUNT\`, \`SUM\`, \`AVG\`, \`MIN\`, \`MAX\`, \`COLLECT\` answer the same whatever order the records come in, so they read anything.
- \`ONLY(…)\` is *the one that matched*: it answers that record or value, and fails the run if there turns out to be more than one. Reach for it whenever a \`WHERE\` narrows to a single thing.
- \`JOIN\`, \`FIRST\` and \`LAST\` read a sequence, so they need one — an \`ORDER BY\` on the hop, or a relationship the source keeps in order (a channel's messages, an email's attachments). Without either they are refused while you write. The traversal chapter's *record-order* has the full rules.
- \`JOIN(list, ", ")\` takes the separator as its second argument; over a bound block it joins what the iterations returned.
- \`SORT(list)\` answers the same members in order, so a \`JOIN\`, \`FIRST\`, \`LAST\` or \`AT\` over it reads a sequence. Plain values sort by themselves — \`SORT(scores)\`, \`SORT(scores, DESC)\`. Anything with fields takes a key: \`SORT(rows, \`score\`, DESC)\` ranks each member by that field, and the key may be a short path off the member. The direction is last, and \`ASC\` is the default.

### keyed-values

\`\`\`
sections = { intro: "Welcome", body: "The details", sign_off: "the team" }
line     = AT(sections, "body")
\`\`\`

A **dict** is a set of values looked up by name — write it in braces, read it with \`AT(dict, "key")\`. Keys are text and nothing else: a key of some other kind is refused when you save, with the coercion for you to write (\`DATE.FORMAT(d, "YYYY-MM-DD")\` for a day, or a template for anything else) — there is no one right spelling, and a silent choice is how two halves of the same automation come to disagree about the same day.

A lookup answers \`T | absent\`: a key that is not there is the everyday case, not a failure, so discharge it the way you discharge any other possibly-missing value.

### iterating-values

\`\`\`
lines    = ch-[m:Messages]-> { return m.\`Text\` }
bulleted = MAP(lines, (t) => { return "• \${t}" })
kept     = FILTER(lines, (t) => { return LENGTH(t) > 0 })
total    = REDUCE(lines, 0, (carried, t) => { return carried + LENGTH(t) })
\`\`\`

Records are walked with a traversal-headed block; **values** are iterated with these five, each given a function that runs once per member.

- \`MAP(list, f)\` answers what \`f\` returned, member by member. \`FILTER(list, f)\` keeps the members \`f\` answered \`TRUE\` for. Both hand back a list in the order they were given one.
- \`REDUCE(list, <start>, f)\` carries a value forward — \`f\` is given what it has so far and the next member. It reads the members one after another, so it needs a list with an order, exactly as \`JOIN\` does.
- \`GROUPBY(list, key)\` files each member under the key its function answers, and hands back a dict of **lists**. \`KEYBY(list, key)\` does the same where each key names one member, and hands back a dict of members — a repeated key fails the run, naming it.

A function written in place takes its parameter's type from the collection, so there is nothing to annotate. It must \`return\` something, and it may not \`await\` — these build one value out of every member, and there is no answer for what the collection is mid-wait, so wait outside the loop (a traversal-headed block, or \`await parallel([…])\`).

\`\`\`
theses = MEMBERS(<Thesis>)
\`\`\`

\`MEMBERS(<T>)\` lists a closed type's values in the order they were **declared** — a refinement you wrote, or a field's option set borrowed from a system. That order is a fact about the type, so a report's sections come from the declaration instead of a list kept beside it. A field whose values are merely *known* (other values are legal there too) has no complete membership, and is refused.

### values-that-may-not-be-there

\`\`\`
Name: COALESCE(msg-[:Sender]->.\`Name\`, msg-[:Sender]->.\`Email\`)
\`\`\`

A traversal that yields nothing makes the value empty rather than failing, and \`COALESCE\` takes the first non-empty of its arguments. To test rather than fall back: \`EXISTS(…)\` tests whether a relationship, a binding, or a field read off one has anything in it — \`EXISTS(msg-[:Sender]->)\`, \`EXISTS(\`Suggested Action\`)\`, \`EXISTS(channel.\`Topic\`)\` — while \`ISNULL(x)\` is the same test inverted.

A separate and stronger thing is a value typed as *possibly not there at all* — \`T | absent\`. That is a real part of the type, not a caution. Four things produce one:

- **an aggregate that can come up empty.** \`ONLY\`, \`FIRST\`, \`LAST\`, \`MIN\`, \`MAX\`, and \`AT\` all answer null when there's nothing to aggregate over, so \`ONLY(msg-[:Attachments]->.\`Name\`)\` may be absent exactly when there are no attachments. Over a *bare* traversal (no field on the end) they bind the whole record, not one of its fields — \`channel = ONLY(chat-[ch:Channels WHERE …]->)\` — see *looking-up-existing-records* in the writes chapter for that idiom;
- **a landing that can resolve empty** — awaiting an answer that was cancelled rather than given yields nothing to read;
- **a \`race\` slot** — \`AT(r, 0)\` reads what the first arm of a \`race\` returned, and only the arm that settled first has its slot filled, so every slot off a \`race\` may be absent. (\`parallel\` waits for every arm, so its slots are not.)
- **an extracted field, and a dict lookup.** Every field of an \`extract\` is something the model was asked for and may not have found, so reading one is \`T | absent\` — a write field takes it with the \`?:\` fill rather than plainly. \`AT(dict, key)\` is the same: a key that is not there reads nothing.

Reading such a value is always fine. What is refused is **using** it somewhere a value is genuinely required — a write field, a write or traversal target, a field read off it, an ordered comparison (\`<\`, \`<=\`, \`>\`, \`>=\`) — and the refusal comes while you write rather than at run time. There is no "it will probably be there".

Five things discharge it, and one of them always fits:

- **Fill it with \`?:\`.** A set-if-empty write field takes a possibly-missing value happily: present, it lands; missing, that one field simply isn't written and the rest of the write goes ahead.

  \`\`\`
  Description ?: "Headcount: \${a.Answer}"
  \`\`\`

- **Gate on it with a traversal.** A block headed by the landing runs only when the landing is there, and everything inside it knows so: \`q-[a:Response]-> { … }\`.
- **Test it with \`==\`.** Comparing against \`null\` (\`x == null\` / \`x != null\`) is the dedicated presence test, and the one place \`==\` is deliberately loose: \`null\` and absent mean the same thing here, so it's legal against *any* possibly-missing value. Comparing against a present value works too and narrows the same way (\`if a.Answer == "pursue" { … }\` is legal even though \`a.Answer\` may be absent). Either way, the arm that took the comparison knows the value is present — and for \`== null\` used as a guard clause (\`if x == null { ERROR("…") }\`), so does everything **after** the \`if\`, not just the arm. See *narrowing-past-a-guard* in the branching chapter.
- **Fall back with \`COALESCE\`.** \`COALESCE(a, b)\` answers the first of its arguments that has a value, so the moment one of them always does — a literal, or anything already known to be there — the result always does too: \`Name: COALESCE(ONLY(msg-[:Attachments]->.\`Name\`), "no attachment")\`. A \`COALESCE\` whose arguments might *all* be empty is itself possibly-empty and is refused in the same places, so the one-argument form discharges nothing at all.
- **Test it with \`EXISTS\` or \`ISNULL\`.** \`if EXISTS(x) { … }\` narrows \`x\` present *inside that arm only*; the value-level form \`IF EXISTS(x) THEN … ELSE … END\` narrows it present in the \`THEN\` branch only. \`ISNULL\` is that test inverted, which is what a guard clause wants: \`if ISNULL(x) { ERROR("…") }\` proves \`x\` present for everything after the \`if\`. Either takes a bound name or a field read off one — \`if EXISTS(channel.\`Topic\`) { … }\` needs no intermediate binding, and since a field is missing only because its record is, proving the field proves the record with it, so that arm may write off \`channel\` too.

Ordered comparisons get no licence from the \`?:\` fill — there is no write field to fill — so either give the value a fallback with \`COALESCE\`, or prove presence first (a guard clause, an \`EXISTS\`, a traversal gate) and order *inside* the branch — or, for a guard clause, the code after it — that proved it.

### helper-families

Dotted helper families — \`FAMILY.FUNCTION(…)\` — do the messy real-world conversions deterministically: no model involved, the same input always gives the same answer, and an input the helper can't read gives an empty value rather than an error. \`CURRENCY.\` reads money figures out of text (\`"£1.2m"\` → \`1200000\`, or its code → \`"GBP"\`); \`TEXT.\` does surgical string work (a regex extraction, a slug); \`DATE.\` handles dates without guesswork — \`DATE.PARSE("12 March 2026")\` → \`"2026-03-12"\`, while an ambiguous numeric form (\`"12/03/2026"\` — day-first or month-first?) deliberately gives empty rather than a guess. \`DATE.FORMAT(value, "MMMM D, YYYY")\` writes a date out for a person to read — \`"August 31, 2026"\` — from the tokens \`YYYY YY MMMM MMM MM M DD D dddd ddd HH H mm m ss s\`, with anything that is not a letter printed as written; the pattern is written down and checked when you save, so an unknown token is named there rather than printed wrong. \`DATE.TODAY(zone)\` and \`DATETIME.AT(date, time, zone)\` do time zones — the next section. The reference chapter lists every family member; a name that isn't one is refused when you save, with the family's real functions listed.

### time-zones-and-windows

Take the day in a place, move whole days on it, and anchor each end of the window on its own:

\`\`\`
berlin_today = DATE.TODAY("Europe/Berlin")
win_end      = DATETIME.AT(berlin_today, "07:00", "Europe/Berlin")
win_start    = DATETIME.AT(DATE.ADD_DAYS(berlin_today, -1), "07:00", "Europe/Berlin")
\`\`\`

**Arithmetic happens in calendar space; anchoring happens last.** \`DATE.ADD_DAYS\` moves a day on the calendar, and \`DATETIME.AT(date, time, zone)\` turns a day plus a wall-clock time into the one instant it names there. Anchor each end separately and the window between yesterday 07:00 and today 07:00 comes out 23 or 25 hours long on the two days a year the clocks move, without you writing anything down. Anchor one end and subtract 24 hours instead, and those two days silently run from 06:00 or 08:00.

\`DATE.TODAY(zone)\` reads the moment the run fired, in that zone — a run firing at 00:30 in Berlin is on the Berlin date, not yesterday's UTC one. Every reading of the clock in one run gives the same answer, including after the run waits for a person, so a window computed at the start and one computed at the end agree.

Both the zone (\`"Europe/Berlin"\`, \`"America/New_York"\`, \`"UTC"\`) and the time (\`"07:00"\`, 24-hour \`HH:mm\`) are written down and checked when you save. \`DATETIME.AT\` always names an instant: on the spring-forward morning a time the clock skips resolves forward to the moment the clock resumed, and on the fall-back morning a time that happens twice takes the first of the two.

### coercers

\`DATE\` and \`DATETIME\` are each two things by the same name, and the dot tells them apart: \`DATE.PARSE(…)\` and \`DATETIME.AT(…)\` are helper families, while the bare \`DATE(value)\` and \`DATETIME(value)\` are **coercers** — they, and \`NUMBER(value)\`, say "treat this as a calendar day / an instant / a number". Reach for a coercer when a comparison spans two kinds of value: a comparison only makes sense within one kind, so \`\`Snoozed Until\` <= 5\` is refused when you save and \`\`Snoozed Until\` <= DATE(…)\` is the repair. (Dates and timestamps compare freely — a date is midnight. When a value's type isn't known, the comparison is left alone; only a definite clash is flagged.)

Prefer a helper over \`AI()\` whenever one fits: it is instant, free, and gives the same answer every run.

Beyond the built-ins, a target system may supply functions of its own on particular fields — a chat system's message formatter on a message's text, say. Those run **as the value of the write field that advertises them**: the target supplies the function, so it exists exactly where you write to that target. Calling one anywhere else — a condition, a plain binding — or calling a name no field advertises, fails the run naming the function.

### file-artifacts

\`\`\`
File: FILE(digest, "pdf")
\`\`\`

\`FILE(content, type)\` turns a composed string into a **file** you can write into a file-typed field — an attachment, a document slot. \`type\` is a literal \`"pdf"\` or \`"text"\`, and the content is rendered as plain text preserving your line breaks, so compose it first (interpolation, or \`JOIN\` over a block's results — the patterns chapter has the digest shape) and then wrap it. The artifact remembers where its content came from: its provenance trail carries the reads that fed the string.`,
  engineClaims: [
    {
      construct: 'SORT over a collection in hand, then an order-sensitive fold',
      status: 'runs',
      probe: `
import { manual, attio } from adapters
import { acme } from credentials

runs = manual()
crm  = attio(credentials: acme)

function \`Roster\`(go: <runs-[:Invocation]->>) {
  names  = crm-[p:People]-> { return p.\`Name\` }
  titles = crm-[p:People]-> { return { name: p.\`Name\`, title: p.\`Job Title\` } }
  ranked = SORT(titles, \`title\`, DESC)
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name: COALESCE(FIRST(SORT(names)), "nobody")
    Description: "\${COUNT(ranked)} people, \${JOIN(SORT(names, DESC), ", ")}"
  }
}

listen to runs {} fire \`Roster\`
`,
    },
    {
      construct: 'AI() null returns gated with EXISTS() on the binding',
      status: 'runs',
      probe: `
import { email, slack } from adapters
import { acme_slack } from credentials

inbox = email()
team  = slack(credentials: acme_slack)

function \`Follow Up\`(m: <inbox-[:Email]->>) {
  \`Suggested Action\` = AI("a brief, actionable next step — only if one is genuinely needed")
  if EXISTS(\`Suggested Action\`) {
    team-[ch:Channels WHERE \`Name\` == "follow-ups"]-> {
      write ch-[:Messages]-> { Message: \`Suggested Action\` }
    }
  }
}
`,
    },
    {
      construct: 'AI() values and file-scope prompt bindings (bare-name reads)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

\`Company Prompt\` = "the company name this email is about"

function \`Intake\`(m: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    Name: AI(\`Company Prompt\`)
    Description: AI("summarise this message")
  }
}
`,
    },
    {
      construct: 'AI() tiers — how much thinking the answer is worth',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Triage\`(m: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    Name:        AI("the company name this email is about", "quick")
    Domains:     AI("the company's website", "careful")
    Description: AI("weigh this company against our thesis and say where it lands", "thorough")
  }
}
`,
    },
    {
      construct: 'EXISTS() tests, including hop WHERE filters',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  if EXISTS(m-[:Attachments]-> WHERE \`Name\` CONTAINS "pdf") {
    write crm-[:Companies]-> { Name: m.\`Subject\` }
  }
}
`,
    },
    {
      construct: 'COALESCE and the built-in function helpers',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    Name: COALESCE(m.\`Subject\`, "unknown")
    Description: UPPER(TRIM(m.\`Subject\`))
  }
}
`,
    },
    {
      construct: 'integration-provided functions as write-field values',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    Name: DOMAIN_OF(m.\`Subject\`)
  }
}
`,
    },
    {
      construct: 'integration functions outside a write field (invalid everywhere)',
      status: 'pending',
      flag: 'non-built-in function calls',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  if DOMAIN_OF(m.\`Subject\`) == "acme.dev" {
    write crm-[:Companies]-> { Name: m.\`Subject\` }
  }
}
`,
    },
    {
      construct: 'namespaced helper families (CURRENCY.*, DATE.*, TEXT.*) and bare coercers DATE()/DATETIME()/NUMBER()',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  if TEXT.REGEX_EXTRACT(m.\`Subject\`, "(DEAL-\\\\d+)") EXISTS {
    company = write crm-[:Companies]-> {
      Name:        TEXT.SLUG(m.\`Subject\`)
      Description: CURRENCY.GET_CODE_FROM_FIGURE(m.\`Body\`)
      \`Team Size\`: NUMBER(m.\`Body\`)
    }
    write company-[:Tasks]-> {
      Content:  "Follow up on \${m.\`Subject\`}"
      Deadline: DATE.ADD_DAYS(@current_date, 14)
    }
    write company-[:Notes]-> {
      Title:   "Received"
      Content: "\${DATE(@current_date)} / \${DATETIME(m.\`Body\`)} / \${DATE.FORMAT(@current_date, "MMMM D, YYYY")}"
    }
  }
}
`,
    },
    {
      construct: 'DATE.TODAY(zone) + DATETIME.AT(date, time, zone) — a zone-anchored window',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  berlin_today = DATE.TODAY("Europe/Berlin")
  win_end      = DATETIME.AT(berlin_today, "07:00", "Europe/Berlin")
  win_start    = DATETIME.AT(DATE.ADD_DAYS(berlin_today, -1), "07:00", "Europe/Berlin")
  company = write crm-[:Companies]-> { Name: m.\`Subject\` }
  write company-[:Notes]-> {
    Title:   "Window"
    Content: "\${win_start} → \${win_end} (\${berlin_today})"
  }
}
`,
    },
    {
      construct: 'FILE() artifacts as write-field values',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  digest = "From: \${m.\`Subject\`}"
  company = write crm-[:Companies]-> {
    Name: m.\`Subject\`
  }
  write company-[:Files]-> {
    File: FILE(digest, "pdf")
  }
}
`,
    },
    {
      construct: 'ambient values (@user_email, @actor_*, @current_date)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  write crm-[:Companies]-> {
    Name:          m.\`Subject\`
    Description ?: "Owner: \${@user_email} — from \${@actor_name} on \${@current_date}"
  }
}
`,
    },
    {
      construct: "'== null' as a presence guard clause that narrows a maybe-absent FIRST() scalar",
      status: 'runs',
      probe: `
import { attio } from adapters
import { acme } from credentials

crm = attio(credentials: acme)

function m(evt: <crm-[:\`Webhook Event\` WHERE \`action\` == "record.created"]->>) {
  evt-[co:Companies]-> {
    domain = FIRST(co.Domains)
    if domain == null { ERROR("no domain on this company") }
    write co { Description: domain }
  }
}
`,
    },
  ],
};
