// What an author should know about `@lf/jev` before reaching for it: the two
// calls, when Jev is the better choice than a model, what it reads and what
// it costs. A host adds it to the handbook as the `plugin:jev` chapter; it is
// held to the handbook's prose contract and its probe to the handbook's
// catalog with these plugins added (__test__/handbook_section.unit.test.ts).

import type { HandbookSection } from 'engine-contracts';

const INTAKE = `
import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { \`@lf/jev\` as jev } from plugins
import { acme } from credentials

inbox = connect email
crm   = connect attio using acme

function \`Sort Inbound\`(m: <inbox-[:Email]->>) {
  wanted = jev.score(m.Body, "Is this email asking us to meet or to buy something?")
  if (wanted >= 0.7) {
    kind = jev.classify({ subject: m.Subject, body: m.Body }, ["introduction", "sales pitch", "support request", "other"], "What kind of email is this?")
    write crm-[:Companies]-> {
      Name:        m.Subject
      Description: "\${kind.label} (\${kind.confidence})"
    }
  }
}

listen to inbox { key: "sort-inbound" } fire \`Sort Inbound\`
`;

export const JEV_HANDBOOK_SECTION: HandbookSection = {
  title: 'Jev — cheap yes-or-no and pick-a-label judgements',
  content: `## Jev — cheap yes-or-no and pick-a-label judgements

\`@lf/jev\` puts a question to Jev, a judge that answers with a probability instead of writing text. It is far cheaper and faster than a model, and it only decides: it never writes, summarises or explains.

\`\`\`${INTAKE}\`\`\`

- \`jev.score(subject, question)\` answers a number: how likely the statement is true, from 0 to 1.
- \`jev.classify(subject, labels, question)\` answers \`{ label, confidence }\`: the one label that fits best, and how likely it is right.

### jev-or-ai — which one to reach for

- **Jev** for a yes-or-no decision, or a pick from a few labels, over a text or a record: routing, filtering, a gate before an expensive step. Jev charges about $0.04 per million tokens it reads, so a short email costs a few hundred-thousandths of a dollar, and it answers in about half a second.
- **\`ai(…, { tier: "quick" })\`** when the answer has to be written: a name, a summary, a reason, a label nobody listed in advance.
- **\`extract\`** when the answer is fields pulled out of content.
- Pick the threshold for a score per question, from a handful of real examples. A gate that must not let a wrong item through wants a high bar.

### what-jev-reads

- The subject is a text, or a record of the fields that matter (\`{ subject: m.Subject, body: m.Body }\`), read with the empty ones left out. Jev sees the subject and the question and nothing else from the run.
- Jev reads at most about 30,000 tokens (roughly 90,000 characters). A larger subject fails the call before anything is sent, saying how large it was: pass the fields that matter, or one piece of a long text (\`Text.chunks\`).
- Each label describes its option to Jev, so a few plain words beat a code: \`"sales pitch"\` rather than \`"SP"\`. Give at least two, each once.

### cost-and-failures

- Each call counts what it cost against the run's cost cap, like a model call, and is not started once the run has spent its cap.
- A refused API key fails the run, naming the credential. A busy Jev is tried three times before the run fails.
`,
  engineClaims: [{ construct: 'jev.score and jev.classify as a gate and a label', status: 'runs', probe: INTAKE }],
};
