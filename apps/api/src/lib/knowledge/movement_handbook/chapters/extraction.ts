import type { Chapter } from '../types';

export const extraction: Chapter = {
  id: 'extraction',
  title: 'Extraction — structured records from unstructured data',
  content: `## Extraction — structured records from unstructured data

Use \`extract\` to turn free text and documents into records you can traverse and write from. One declared tree produces the whole result in a single pass, and afterwards its values read as plain properties. For a single value — a summary, a category — use \`AI()\` instead.

### basics

\`\`\`
function \`Intake\`(go: <runs-[:Invocation]->>) {
  found = extract from [go.\`Text\`, go-[:Files]->.\`File\`] {
    node company: "each company named in the supplied text or files" {
      name:    "the company's name"
      website: "the company's official website, if given"
      stage:   <crm-[:Onboarding]->.Stage> "how far along this company is"

      node person: "each person at this company named in the input" {
        name:  "the person's full name"
        email: "the person's email address, if given"
      }
    }
  }

  found-[c:company]-> {
    record = write crm-[:Companies]-> {
      unique by (FUZZY \`Name\`)
      Name:    c.name
      Domains: c.website
    }

    write record-[:Lists]-> {
      listName: "Onboarding"
      Stage ?:  c.stage
    }

    c-[p:person]-> {
      write record-[:Team]-> {
        unique by (FUZZY \`Name\`)
        Name:  p.name
        Email: p.email
      }
    }

    c-[r:_resources WHERE type == "FILE"]-> {
      write record-[:Files]-> {
        File: r.\`file\`
      }
    }
  }
}
\`\`\`

- \`from [ … ]\` lists the source data — body text, attachment files, several at once. Documents are read as text; audio is transcribed, and the spoken words join the source text like any other file's content.
- \`node <name>: "<description>"\` declares a kind of record, and the description carries the cardinality: "the company" yields one, "each company" yields all. A record with no value in any of its fields is dropped rather than emitted all-null — say so in the description if you want the empty ones. Where a record may genuinely not be there, say so too: "the company, if mentioned" keeps one from being invented to fill the slot.
- Every field is something the model was **asked** for and may not have found, so reading one is \`T | absent\`: a write field takes it with the \`?:\` fill (\`Stage ?: c.stage\`), or give it a fallback with \`COALESCE\`, or gate on it first. The *values-that-may-not-be-there* section of the expressions chapter has every discharge.
- Nest a \`node\` when a child only makes sense inside its parent — a company's people, an order's line items. The child arrives already attached, so the write that links them has the relationship in hand.
- A field's type comes from its annotation and nowhere else: a primitive (\`amount: <number> "the order's total"\`), a set of values you write out yourself (\`type Thesis = <"Consumer" | "Infra">\` at the top of the file, then \`thesis: <Thesis> "which thesis this fits"\`), or another field's type borrowed by its path (\`<crm-[:Onboarding]->.Stage>\`). A written set does everything a borrowed one does — it tells the extraction which values to pick from, and a value that is not one of them is flagged when you save; the values are ordinary text everywhere else. Borrowing is how a value lands in an option field — the annotation binds that field's live option list, re-read every run, so an option added there is usable on the next run with no edit here. A target that publishes no options borrows as plain text. An annotation that disagrees with the field you write it into — a \`<number>\` landing in an option field — is flagged when you save.
- The binding (\`found\`) is the result's root: traverse it with ordinary blocks, read its fields with ordinary reads. Fields declared outside any \`node\` describe the source as a whole (\`found.sentiment\`).
- A larger declared tree runs on a more capable model, so it costs more. Declare the records and fields you will use, not every one you could.

### how hard it works

\`\`\`
found = extract "thorough" from [go.\`Text\`] {
  node company: "each company named in the supplied text" {
    name:   "the company's name"
    thesis: "how this company fits the fund's thesis, argued in a sentence"
  }
}
\`\`\`

A tier after \`extract\` says how much thinking the extraction is worth — the same three words \`AI()\` takes, meaning the same things:

- \`"quick"\` — fast and cheap. Right when the values are sitting in the text and only have to be lifted out: names, dates, amounts, addresses.
- \`"careful"\` — a solid general answer. Right when a field calls for a small judgement, or the source is messy.
- \`"thorough"\` — slow and expensive, and it genuinely reasons. Worth it when a field needs the model to work something out from the source rather than find it there.

It applies to the whole extraction — every stage, every record, the nested trees too. There is no per-field or per-stage tier: one declared tree is one job, and its cost should be one thing you can read off the top of it.

Leave it off and the extraction sizes itself from the tree you declared, which is what it has always done. Naming a tier is you overriding that, in either direction: \`"quick"\` on a big tree of plain fields is the cheapest thing here, and \`"thorough"\` on a small tree of hard ones is worth what it costs.

### through

\`\`\`
mentions = extract from [msg.\`Body\`] through [vc_url_retrieval] {
  node company: "each company mentioned" {
    name:    "the company's name"
    website: "the company's official website"
  }
}
\`\`\`

\`through [ … ]\` runs plugins over the source data before extraction, or between a node's stages. A stage is an ordinary call — the plugin is a function, and this is where it is called.

- Most plugins are fed the content they work over by the extraction itself, so you just name them — \`vc_url_retrieval\` scans the \`from [ … ]\` text for links, fetches them, and feeds the pages back in. A plugin that needs *other* inputs takes them as named arguments (\`vc_url_retrieval(email: @user_email)\` to get past an email-gated link), and a bare name in an argument resolves against the record's own extracted fields first. A plugin the extraction feeds only makes sense as a stage, and calling it anywhere else is refused, naming the stage to write it in.
- A stage inherits every field the stage before it declared, so a later stage declares only what it changes — a field you are happy with is not restated. Re-declaring a field is how you transform it: the later description is what runs, and its value is the one you read back.
- A stage runs only when its plugins bring something back. When every plugin of a stage is skipped for that record, or runs and finds nothing, there is nothing there the earlier stage did not already read: the stage's own fields are left with no value, and a field it re-declares keeps the value it already had.
- Several plugins in one pipeline cover each other. \`through [fetch_url(url: website, email: @user_email), web_research(name: name, context: description, website: website, linkedin: linkedin)]\` loads the page for a record that arrived with an address, and researches the address for one that arrived with nothing but a name — each plugin is handed the record's link fields so it stands down where another has it covered.

### source-content-of-an-extracted-node

\`\`\`
c-[r:_resources WHERE type == "FILE"]-> {
  write record-[:Files]-> { File: r.\`file\` }
}
\`\`\`

Every record \`extract\` produces carries what it was extracted from on its \`_resources\` edge — read off the extracted record, never off the input (the input's files are the ones you listed in \`from [ … ]\`). Filter by \`type\`: \`"TEXT"\` for the text segments the extraction read, \`"FILE"\` for the source files, which are there whether or not any text could be read out of them. A file resource carries the real bytes on its \`file\` field, so a write can attach the very document a record came from to that record. The sources fed the whole extraction, so every record in the tree carries the same ones — a nested record's \`_resources\` is its parent's.`,
  engineClaims: [
    {
      construct: 'extract tier — one tier for every stage of the extraction',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Assess\`(m: <inbox-[:Email]->>) {
  found = extract "thorough" from [m.\`Body\`] {
    node company: "each company named in this message" {
      name:   "the company's name"
      thesis: "how this company fits the fund's thesis, argued in a sentence"
    }
  }
  found-[c:company]-> {
    write crm-[:Companies]-> {
      unique by (FUZZY \`Name\`)
      Name:         c.name
      Description ?: c.thesis
    }
  }
}
`,
    },
    {
      construct: 'borrowed type annotations on extraction fields (enum binding)',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

function \`Log Stage\`(m: <inbox-[:Email]->>) {
  mentioned = extract from [m.\`Body\`] {
    node company: "each company mentioned in this message" {
      name:  "the company's name"
      stage: <crm-[:\`VC Deal Flow\`]->.Stage> "how far along the pipeline this company is"
    }
  }
  mentioned-[c:company]-> {
    record = write crm-[:Companies]-> {
      unique by (FUZZY \`Name\`)
      Name: c.name
    }
    write record-[:Lists]-> {
      listName: "VC Deal Flow"
      Stage ?:  c.stage
    }
  }
}
`,
    },
    {
      construct: 'author-declared refinements (`type X = <"A" | "B">`) as extraction field types',
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials

inbox = email()
crm   = attio(credentials: acme)

type Thesis = <"Consumer" | "Infra" | "Health">

function \`Log Thesis\`(m: <inbox-[:Email]->>) {
  mentioned = extract from [m.\`Body\`] {
    node company: "each company mentioned in this message" {
      name:   "the company's name"
      thesis: <Thesis> "which of our theses this company fits"
    }
  }
  mentioned-[c:company]-> {
    write crm-[:Companies]-> {
      unique by (FUZZY \`Name\`)
      Name:        c.name
      Description: "Thesis: \${c.thesis}"
    }
  }
}
`,
    },
    {
      construct: "'through'-staged extraction pipelines",
      status: 'runs',
      probe: `
import { email, attio } from adapters
import { acme } from credentials
import { vc_url_retrieval } from plugins

inbox = email()
crm   = attio(credentials: acme)

function \`Intake\`(m: <inbox-[:Email]->>) {
  mentions = extract from [m.\`Body\`] through [vc_url_retrieval] {
    node company: "each company mentioned in this message" {
      name: "the company's name"
      website: "the company's official website"
    }
  }
  mentions-[c:company]-> {
    write crm-[:Companies]-> {
      unique by (\`Name\`)
      Name: c.name
    }
  }
}
`,
    },
    {
      construct:
        "carrying an extracted node's source file forward via _resources (extract from explicit files → write the source file onto the record)",
      status: 'runs',
      probe: `
import { manual, attio } from adapters
import { acme } from credentials

runs = manual()
crm  = attio(credentials: acme)

function \`Intake With Source\`(go: <runs-[:Invocation]->>) {
  found = extract from [go.\`Text\`, go-[:Files]->.\`File\`] {
    node company: "each company named in the supplied text or files" {
      name:    "the company's name"
      website: "the company's official website, if given"

      node person: "each person at this company named in the input" {
        name:  "the person's full name"
        email: "the person's email address, if given"
      }
    }
  }

  found-[c:company]-> {
    record = write crm-[:Companies]-> {
      unique by (FUZZY \`Name\`)
      Name:    c.name
      Domains: c.website
    }

    c-[p:person]-> {
      write record-[:Team]-> {
        unique by (FUZZY \`Name\`)
        Name:  p.name
        Email: p.email
      }
    }

    c-[r:_resources WHERE type == "FILE"]-> {
      write record-[:Files]-> {
        File: r.\`file\`
      }
    }
  }
}

listen to runs {} fire \`Intake With Source\`
`,
    },
  ],
};
