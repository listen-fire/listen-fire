import type { Chapter } from '../types';

export const builtins: Chapter = {
  id: 'builtins',
  title: 'Builtins',
  content: `## Builtins — every function and helper family, one entry each

Every built-in function, one section each — fetch one by name (\`builtins#SUM\`) instead of the whole chapter. Each entry gives the signature, what it means, whether the result is always there or \`T | absent\`, an ordering requirement where one exists, and an example. The reference chapter's *operators-and-functions* is the one-page version of this list; come here for the detail behind one name.

### TRIM

\`TRIM(text)\` → the text with leading and trailing whitespace removed. Null in, null out.

\`\`\`
name = TRIM(msg.\`Subject\`)
\`\`\`

### LOWER

\`LOWER(text)\` → the text, lowercased. Null in, null out.

\`\`\`
key = LOWER(msg.\`From\`)
\`\`\`

### UPPER

\`UPPER(text)\` → the text, uppercased. Null in, null out.

\`\`\`
code = UPPER(TRIM(msg.\`Subject\`))
\`\`\`

### LENGTH

\`LENGTH(text | list)\` → \`number\`, always present — the character count of a text, or the member count of a list. \`0\` for null.

\`\`\`
big = LENGTH(msg.\`Body\`) > 500
\`\`\`

### ABS

\`ABS(number)\` → \`number\`, the absolute value.

\`\`\`
diff = ABS(before - after)
\`\`\`

### ROUND

\`ROUND(number)\` → \`number\`, rounded to the nearest whole number (half rounds up).

\`\`\`
pct = ROUND(score * 100)
\`\`\`

### FLOOR

\`FLOOR(number)\` → \`number\`, rounded down.

\`\`\`
pages = FLOOR(LENGTH(text) / 3000)
\`\`\`

### CEIL

\`CEIL(number)\` → \`number\`, rounded up.

\`\`\`
batches = CEIL(COUNT(rows) / 50)
\`\`\`

### TOSTRING

\`TOSTRING(value)\` → the value's text form. Null in, null out — a number, date, or boolean prints as its usual text; a record or list is refused (write a field off it instead).

\`\`\`
label = TOSTRING(amount)
\`\`\`

### TONUMBER

\`TONUMBER(text)\` → a number parsed out of the text, or nothing when it doesn't parse — treat it like any other value that can come back empty (\`?:\`, \`COALESCE\`, or a guard) before using it where a number is required.

\`\`\`
n = TONUMBER(msg.\`Subject\`)
\`\`\`

### SPLIT

\`SPLIT(text, separator?)\` → a list of text, always present (empty when the text is empty). Each piece is trimmed and empty pieces are dropped; \`separator\` defaults to \`","\`.

\`\`\`
tags = SPLIT(msg.\`Subject\`, ";")
\`\`\`

### MULTI

\`MULTI(a, b, c, …)\` → a flat list of the arguments with nulls dropped, always present. A list argument flattens one level in, so \`MULTI\` is the way to combine several possibly-empty values (or lists of them) into one list.

\`\`\`
Tags: MULTI("inbound", region, [\`Sub Tag\`])
\`\`\`

### ISNULL

\`ISNULL(x)\` → \`boolean\`, always present — the presence test inverted (\`ISNULL(x)\` is \`x == null\`). Takes a bound name or a field read off one (\`ISNULL(x.\`Field\`)\`), and proving a field absent proves nothing about the record it came off — proving it *present* (\`EXISTS\`) is what narrows the record.

\`\`\`
if ISNULL(\`Suggested Action\`) { ERROR("nothing to act on") }
\`\`\`

### EXISTS

\`EXISTS(x)\` → \`boolean\`, always present — whether a relationship, a binding, or a field read off one has anything in it. Takes a bound name, a field read (\`EXISTS(channel.\`Topic\`)\`), or a bare traversal with an optional \`WHERE\` (\`EXISTS(m-[:Attachments]-> WHERE \`Name\` CONTAINS "pdf")\`). \`if EXISTS(x) { … }\` narrows \`x\` present *inside that arm only*; \`IF EXISTS(x) THEN … ELSE … END\` narrows the same way inside its \`THEN\`.

\`\`\`
if EXISTS(msg-[:Attachments]->) { … }
\`\`\`

### CONCAT

\`CONCAT(a, b, …)\` → \`text\`, always present — joins its arguments as text. A part that is \`T | absent\` is accepted and prints as nothing, the same rule interpolation follows (\`"\${x}"\` desugars to this same call). A structured value (a dict, a record) is refused — write a field off it first.

\`\`\`
line = CONCAT(msg.\`From\`, " — ", msg.\`Subject\`)
\`\`\`

### COALESCE

\`COALESCE(a, b, …)\` → the first argument with a value, present whenever at least one argument is unconditionally present (a literal, or anything already known to be there). A \`COALESCE\` whose arguments might *all* be empty is itself \`T | absent\` and discharges nothing.

\`\`\`
Name: COALESCE(msg-[:Sender]->.\`Name\`, msg-[:Sender]->.\`Email\`, "unknown")
\`\`\`

### COUNT

\`COUNT(list | traversal)\` → \`number\`, always present, reads any order. The member count.

\`\`\`
n = COUNT(co-[t:Team]->)
\`\`\`

### SUM

\`SUM(list of number)\` → \`number\`, always present, reads any order — the total. \`0\` over an empty list.

\`\`\`
total = SUM(co-[o:Orders]->.Amount)
\`\`\`

### AVG

\`AVG(list of number)\` → \`number\`, always present, reads any order — the mean.

\`\`\`
average = AVG(co-[o:Orders]->.Amount)
\`\`\`

### MIN

\`MIN(list)\` → \`T | absent\`, reads any order — the smallest member; absent over an empty list. The element must be orderable (a number, date, datetime, or text).

\`\`\`
earliest = MIN(co-[o:Orders]->.\`Placed At\`)
\`\`\`

### MAX

\`MAX(list)\` → \`T | absent\`, reads any order — the largest member; absent over an empty list.

\`\`\`
biggest = MAX(co-[o:Orders]->.Amount)
\`\`\`

### ONLY

\`ONLY(list | traversal)\` → \`T | absent\`, reads any order — *the one that matched*: answers that record or value, and fails the run if there turns out to be more than one. Reach for it whenever a \`WHERE\` narrows to a single thing; over a bare traversal it binds the whole record.

\`\`\`
channel = ONLY(chat-[ch:Channels WHERE \`Name\` == "ops"]->)
\`\`\`

### COLLECT

\`COLLECT(list | traversal)\` → a list, always present (empty rather than absent), reads any order but keeps the source's order when it has one. Materialises a traversal into an ordinary list value — the form to reach for when a later fold (\`JOIN\`, \`FIRST\`, \`AT\`) needs one and the traversal itself has none to give.

\`\`\`
names = COLLECT(co-[p:People]->.\`Name\`)
\`\`\`

### JOIN

\`JOIN(list, separator)\` → \`text\`, always present — needs an ordered sequence (an \`ORDER BY\` on the hop, a relationship the source keeps in order, or a \`SORT\`), refused otherwise naming the fix. Over a bound block it joins what the iterations returned.

\`\`\`
roster = JOIN(SORT(co-[t:Team]->.\`Name\`), ", ")
\`\`\`

### SORT

\`SORT(list)\` / \`SORT(list, DESC)\` / \`SORT(list, key)\` / \`SORT(list, key, DESC)\` → the same members in order, always present (commutative — reads any order in). Plain values sort by themselves; a list of records or dicts takes a key, which may be a short path off the member. Direction is last, and \`ASC\` is the default.

\`\`\`
ranked = SORT(rows, \`score\`, DESC)
\`\`\`

### FIRST

\`FIRST(list)\` → \`T | absent\` — needs an ordered sequence, exactly as \`JOIN\` does, refused otherwise (the message points at \`ONLY\` when the source is really a single-match lookup).

\`\`\`
newest = FIRST(crm-[c:Companies ORDER BY \`Created At\` DESC]->.\`Name\`)
\`\`\`

### LAST

\`LAST(list)\` → \`T | absent\` — the same ordering requirement as \`FIRST\`, reading the other end.

\`\`\`
oldest = LAST(SORT(co-[o:Orders]->.\`Placed At\`))
\`\`\`

### AT

Two forms, by what you index. \`AT(list, n)\` → \`T | absent\` — a number index into a list, needing an ordered sequence exactly as \`FIRST\` does (refused otherwise). \`AT(dict, "key")\` → present when \`"key"\` is a literal string that is one of the dict's own written keys (a typo is refused with a did-you-mean); \`T | absent\` when the key is computed at run time, or when the dict's per-key shape isn't known (a system value, a \`GROUPBY\`/\`KEYBY\` result — its keys are data, not declarations).

\`\`\`
first  = AT(SORT(names), 0)
bucket = AT({ intro: "Welcome", body: "…" }, "intro")
\`\`\`

### MAP

\`MAP(list, f)\` → a list of what \`f\` returned, member by member, in the order given — always present (each slot may itself be absent when \`f\`'s value is). \`f\` is a function \`(member) => { … }\` and takes its parameter's type from the collection; it may not \`await\`. \`MAP\` alone among the five may skip \`return\` — each slot is then absent and the closure's writes still run — and a bare \`MAP(...)\` with no binding is a legal statement on its own.

\`\`\`
bulleted = MAP(lines, (t) => { return "• \${t}" })
MAP(ch-[m:Messages]->, (m) => { write graph-[:note]-> { text: m.\`Text\` } })
\`\`\`

### FILTER

\`FILTER(list, f)\` → the members \`f\` answered \`TRUE\` for, in order, always present. \`f\` must \`return\` a boolean.

\`\`\`
kept = FILTER(lines, (t) => { return LENGTH(t) > 0 })
\`\`\`

### REDUCE

\`REDUCE(list, start, f)\` → whatever \`f\` last returned, always present when \`start\` is. Needs an ordered list — \`f\` is \`(carried, member) => { … }\` and must \`return\` the next carried value.

\`\`\`
total = REDUCE(lines, 0, (carried, t) => { return carried + LENGTH(t) })
\`\`\`

### GROUPBY

\`GROUPBY(list, key)\` → a dict of lists, always present — files each member under the key its function answers. The values carry the members' own shape (a dict literal's fields read straight off a group); the keys are data, so a lookup with \`AT\` is always \`T | absent\` even against a literal string.

\`\`\`
by = GROUPBY(rows, (r) => { return AT(r, "thesis") })
\`\`\`

### KEYBY

\`KEYBY(list, key)\` → a dict of members, one per key, always present — a repeated key fails the run, naming it. Same shape-carrying and key-lookup rules as \`GROUPBY\`.

\`\`\`
byId = KEYBY(co-[p:People]->, (p) => { return p.\`Email\` })
\`\`\`

### MEMBERS

\`MEMBERS(<T>)\` → a list of a **closed** type's values, always present, in the order they were **declared** — a refinement you wrote, or a field's option set borrowed from a system. Refused on a field whose values are merely *known* (other values are legal there too), since that has no complete membership.

\`\`\`
theses = MEMBERS(<Thesis>)
\`\`\`

### IF THEN ELSE END

\`IF <cond> THEN <a> ELSE <b> END\` — the value-level conditional (uppercase; the lowercase \`if\` branches statements instead). The condition guards its own \`THEN\` the same way a statement \`if\` guards its arm, so a presence test on the condition narrows inside \`THEN\` only.

\`\`\`
line = IF EXISTS(domain) THEN "\${domain}" ELSE "" END
\`\`\`

### unary minus

\`-x\` → \`number\` — arithmetic negation. The operand must already be a number; coerce first if it isn't (\`-NUMBER(x)\`). Parenthesise a sub-expression the same as any arithmetic: \`-(a + b)\`.

\`\`\`
delta = -(after - before)
\`\`\`

### FILE

\`FILE(content, "pdf" | "text")\` → a \`file\` value, always present — turns a composed string into a file for a file-typed field. \`type\` is a literal; the content renders as plain text, line breaks preserved.

\`\`\`
File: FILE(digest, "pdf")
\`\`\`

### READ

\`READ(file)\` → \`text | absent\` — the text in a file. \`extract from [file]\` already means \`extract from [READ(file)]\`; reach for \`READ\` when you want the text in hand to cut, measure, or pass to a plugin.

\`\`\`
text = READ(f.\`File\`)
\`\`\`

### CHUNKS

\`CHUNKS(text, { size | entities, overlap })\` → a list of text, always present — cuts a long text into pieces. \`size\` bounds each piece by characters; \`entities\` instead sizes each piece by the records it is expected to yield, cutting on whole lines; exactly one of the two is written, and \`overlap\` (characters repeated from the piece before) works with either. \`unit:\` takes only \`"chars"\`.

\`\`\`
pieces = CHUNKS(text, { size: 40000, overlap: 2000 })
\`\`\`

### DATE

\`DATE(value)\` → \`date\` — coerces any readable date or timestamp to a calendar day (midnight UTC). Reach for it when a comparison spans two kinds of value.

\`\`\`
\`Snoozed Until\` <= DATE(m.\`Body\`)
\`\`\`

### DATETIME

\`DATETIME(value)\` → \`datetime\` — coerces to a full UTC instant.

\`\`\`
sent = DATETIME(m.\`Date\`)
\`\`\`

### NUMBER

\`NUMBER(value)\` → \`number\` — coerces text to a number.

\`\`\`
\`Team Size\` <= NUMBER(m.\`Body\`)
\`\`\`

### CURRENCY.GET_NUMBER_FROM_FIGURE

\`CURRENCY.GET_NUMBER_FROM_FIGURE(figure)\` → \`number\`, always present (empty when unreadable) — the numeric amount in a money figure.

\`\`\`
amount = CURRENCY.GET_NUMBER_FROM_FIGURE("£1.2m")   # 1200000
\`\`\`

### CURRENCY.GET_CODE_FROM_FIGURE

\`CURRENCY.GET_CODE_FROM_FIGURE(figure)\` → \`text\` — the ISO currency code in a money figure.

\`\`\`
code = CURRENCY.GET_CODE_FROM_FIGURE("£1.2m")   # "GBP"
\`\`\`

### DATE.PARSE

\`DATE.PARSE(text)\` → \`date | absent\` — a written date read as an ISO date; unreadable text (including an ambiguous numeric form like \`"12/03/2026"\`) is absent rather than a guess.

\`\`\`
d = DATE.PARSE("12 March 2026")   # "2026-03-12"
\`\`\`

### DATE.ADD_DAYS

\`DATE.ADD_DAYS(date, days)\` → \`date\`, always present — a date shifted by whole days.

\`\`\`
deadline = DATE.ADD_DAYS(@current_date, 14)
\`\`\`

### DATE.FORMAT

\`DATE.FORMAT(value, pattern)\` → \`text\`, always present — a date written out for a person to read, from the tokens \`YYYY YY MMMM MMM MM M DD D dddd ddd HH H mm m ss s\`; anything that is not a letter prints as written. The pattern is a literal, checked when you save.

\`\`\`
line = DATE.FORMAT(@current_date, "MMMM D, YYYY")   # "August 31, 2026"
\`\`\`

### DATE.FORMAT_ISO

\`DATE.FORMAT_ISO(value)\` → \`date\` — any readable date or timestamp normalised to a full ISO 8601 UTC timestamp.

\`\`\`
iso = DATE.FORMAT_ISO(m.\`Date\`)
\`\`\`

### DATE.TODAY

\`DATE.TODAY(zone)\` → \`date\`, always present — the calendar date it is right now in a place, reading the run's pinned instant (not a live clock: every read in one run gives the same day). \`zone\` is a literal IANA name, checked when you save.

\`\`\`
today = DATE.TODAY("Europe/Berlin")
\`\`\`

### DATETIME.AT

\`DATETIME.AT(date, time, zone)\` → \`datetime\`, always present — the instant a wall-clock time on a date names in a place. \`time\` and \`zone\` are literals, checked when you save. Move days with \`DATE.ADD_DAYS\` and anchor each end of a window separately — a daylight-saving change then takes care of itself.

\`\`\`
win_end = DATETIME.AT(today, "07:00", "Europe/Berlin")
\`\`\`

### TEXT.REGEX_EXTRACT

\`TEXT.REGEX_EXTRACT(text, pattern, group?)\` → \`text\`, empty when nothing matches — the first regex match, or the first capture group when the pattern has one.

\`\`\`
ref = TEXT.REGEX_EXTRACT(m.\`Subject\`, "(DEAL-\\\\d+)")
\`\`\`

### TEXT.SLUG

\`TEXT.SLUG(text)\` → \`text\`, always present — a lowercase-hyphen slug.

\`\`\`
slug = TEXT.SLUG("Acme Corp Ltd.")   # "acme-corp-ltd"
\`\`\`

### URL.HOST

\`URL.HOST(text)\` → \`text | absent\` — the host of a URL, lowercased and otherwise verbatim (\`www.\` kept, no port, no path); absent when the text isn't a URL with a host.

\`\`\`
host = URL.HOST("https://WWW.Acme.com:8080/deals/1")   # "www.acme.com"
\`\`\`

### AI

\`AI("…")\` → a value from a language model, resolving to a real null when nothing applies — gate with \`EXISTS(…)\`. Optional second argument is the tier: \`"quick"\` (default), \`"careful"\`, \`"thorough"\`. See *ai* in the expressions chapter for the full treatment — prompting, tiers, and the null-gating idiom.

\`\`\`
Category: AI("one of: bug, feature, question — for: \${msg.\`Subject\`}")
\`\`\`
`,
  engineClaims: [
    {
      construct: 'flat text/number helpers (TRIM, LOWER, UPPER, LENGTH, ABS, ROUND, FLOOR, CEIL, TOSTRING, TONUMBER, SPLIT, MULTI, ISNULL, CONCAT)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  n    = TONUMBER(m.\`Subject\`)
  tags = MULTI("inbound", SPLIT(m.\`Subject\`, ";"))
  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        UPPER(TRIM(m.\`Subject\`))
    Description: CONCAT(LOWER(m.\`From\`), " — ", TOSTRING(ABS(ROUND(1.6))), "/", TOSTRING(FLOOR(1.6)), "/", TOSTRING(CEIL(1.6)), " — ", TOSTRING(LENGTH(tags)))
    \`Team Size\` ?: n
  }
  big = LENGTH(m.\`Body\`) > 500
  if ISNULL(n) { ERROR("no number in the subject") }
}
`,
    },
    {
      construct: 'COALESCE and EXISTS (including a traversal WHERE form)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  if EXISTS(m-[:Attachments]-> WHERE \`Name\` CONTAINS "pdf") {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name: COALESCE(m.\`From\`, "unknown")
    }
  }
}
`,
    },
    {
      construct: 'the commutative aggregates (COUNT, COLLECT, ONLY) over a captured relationship, plus JOIN/FIRST/LAST/AT(list,n) each ordered inline with SORT',
      status: 'runs',
      probe: `
import { attio } from adapters
import { acme } from credentials

crm = attio(credentials: acme)

function m(evt: <crm-[:\`Webhook Event\` WHERE \`action\` == "record.created"]->>) {
  evt-[co:Companies]-> {
    names = co-[p:Team]-> { return p.\`Name\` }
    n     = COUNT(co-[p:Team]->)
    owner = ONLY(co-[t:Team WHERE \`Job Title\` == "CEO"]->)
    newest = FIRST(SORT(names))
    oldest = LAST(SORT(names, DESC))
    first  = AT(SORT(names), 0)
    write co {
      Description: "\${n} people, \${JOIN(SORT(names), ", ")}, \${COALESCE(owner.\`Name\`, "no CEO")}, \${COALESCE(newest, "")}/\${COALESCE(oldest, "")}/\${COALESCE(first, "")}"
    }
  }
}
`,
    },
    {
      construct: 'SUM/AVG/MIN/MAX over a list of numbers',
      status: 'runs',
      probe: `
import { attio } from adapters
import { acme } from credentials

crm = attio(credentials: acme)

function m(evt: <crm-[:\`Webhook Event\` WHERE \`action\` == "record.created"]->>) {
  evt-[co:Companies]-> {
    amounts = [1200, 400, 900]
    total   = SUM(amounts)
    average = AVG(amounts)
    lowest  = MIN(amounts)
    highest = MAX(amounts)
    write co {
      \`Team Size\` ?: total
      Description: "\${average}/\${COALESCE(TOSTRING(lowest), "")}/\${COALESCE(TOSTRING(highest), "")}"
    }
  }
}
`,
    },
    {
      construct: 'MAP/FILTER/REDUCE/GROUPBY/KEYBY, a bare no-return MAP statement, and AT on a dict literal vs a GROUPBY result',
      status: 'runs',
      probe: `
import { manual, attio } from adapters
import { acme } from credentials

runs = manual()
crm  = attio(credentials: acme)

function \`Roster\`(go: <runs-[:Invocation]->>) {
  d = { bucket: "a", packed: 3 }
  first = AT(d, "bucket")

  rows   = crm-[p:People ORDER BY \`Name\`]-> { return { name: p.\`Name\`, title: p.\`Job Title\` } }
  lines  = MAP(rows, (r) => { return AT(r, "name") })
  kept   = FILTER(lines, (t) => { return LENGTH(t) > 0 })
  total  = REDUCE(kept, 0, (carried, t) => { return carried + LENGTH(t) })
  by     = GROUPBY(rows, (r) => { return AT(r, "title") })
  byName = KEYBY(rows, (r) => { return AT(r, "name") })
  own    = AT(byName, "founder@acme.com")
  ceos   = AT(by, "CEO")

  MAP(rows, (r) => {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name: AT(r, "name")
    }
  })

  write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        first
    Description: "\${JOIN(kept, ", ")} (\${total} chars, has a founder entry: \${EXISTS(own)}, groups: \${EXISTS(ceos)})"
  }
}

listen to runs {} fire \`Roster\`
`,
    },
    {
      construct: 'MEMBERS in declaration order, IF/THEN/ELSE/END, and unary minus',
      status: 'runs',
      probe: `
import { manual, slack } from adapters
import { team_workspace } from credentials

runs = manual()
chat = slack(credentials: team_workspace)

type Thesis = <"Consumer" | "Infra" | "Health">

function \`Recap\`(go: <runs-[:Invocation]->>) {
  theses = MEMBERS(<Thesis>)
  before = 10
  after  = 4
  delta  = -(after - before)
  first  = AT(theses, 0)
  line   = IF EXISTS(first) THEN "\${first}" ELSE "" END

  ops = ONLY(chat-[ch:Channels WHERE \`Name\` == "ops"]->)
  if ops == null { ERROR("no #ops channel") }
  write ops-[:Messages]-> { Message: "\${JOIN(theses, ", ")} / \${line} / \${delta}" }
}

listen to runs {} fire \`Recap\`
`,
    },
    {
      construct: 'FILE/READ/CHUNKS and the bare coercers DATE()/DATETIME()/NUMBER()',
      status: 'runs',
      probe: `
import { manual, attio } from adapters
import { acme } from credentials

runs = manual()
crm  = attio(credentials: acme)

function \`Cut A Document\`(go: <runs-[:Invocation]->>) {
  go-[f:Files]-> {
    text   = READ(f.\`File\`)
    pieces = CHUNKS(COALESCE(text, ""), { size: 40000, overlap: 2000 })
    company = write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name:          COALESCE(FIRST(pieces), "untitled")
      \`Team Size\` ?: NUMBER(COALESCE(FIRST(pieces), ""))
    }
    write company-[:Files]-> {
      File: FILE(JOIN(pieces, "\\n"), "pdf")
    }
    write company-[:Notes]-> {
      Title:   "Window"
      Content: "\${DATE(@current_date)} / \${DATETIME(@current_date)}"
    }
  }
}

listen to runs {} fire \`Cut A Document\`
`,
    },
    {
      construct: 'namespaced helper families: CURRENCY.*, DATE.*, DATETIME.AT, TEXT.*, URL.HOST',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  today = DATE.TODAY("Europe/Berlin")
  win   = DATETIME.AT(today, "07:00", "Europe/Berlin")
  ref   = TEXT.REGEX_EXTRACT(m.\`Subject\`, "(DEAL-\\\\d+)")
  company = write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        TEXT.SLUG(m.\`Subject\`)
    Description: CURRENCY.GET_CODE_FROM_FIGURE(m.\`Body\`)
    \`Team Size\` ?: CURRENCY.GET_NUMBER_FROM_FIGURE(m.\`Body\`)
  }
  write company-[:Notes]-> {
    Title:   "Window"
    Content: "\${COALESCE(DATE.PARSE(m.\`Subject\`), DATE.ADD_DAYS(today, 7))} / \${DATE.FORMAT(today, "MMMM D, YYYY")} / \${DATE.FORMAT_ISO(win)} / \${COALESCE(ref, "")} / \${COALESCE(URL.HOST(m.\`Body\`), "")}"
  }
}
`,
    },
  ],
};
