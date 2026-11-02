// The forms module's manifest: data only, so a host can list it without
// loading the adapter. A form is a record a write makes; what it asks is the
// node the write names in `Fields`, and its one answer lands on its
// `Submissions` typed by that node.

import type { AdapterManifest } from 'movement-engine/public/adapter';

export const FORMS_ADAPTER_TYPE = 'forms';
export const FORM_TYPE = 'Form';
export const FORMS_COLLECTION = 'Forms';
export const SUBMISSION_TYPE = 'Submission';
export const SUBMISSIONS_EDGE = 'Submissions';
/** The write field naming the node a form asks for. */
export const FIELDS_FIELD = 'Fields';

const HANDBOOK = `## Forms

\`@lf/forms\` asks a person for an answer the program's other systems cannot take: a form at a link, answered once. The link is under \`listen-fire serve\`, at lf.yaml's \`publicUrl\`.

\`\`\`
forms = connect forms
mail = connect gmail using my_gmail

node Refund {
  Approve: <boolean>
  Note: <text | null>
}

function ask(run: <manual-[:Invocation]->>) {
  form = write forms-[:Forms]-> { Title: "Approve the refund?", Fields: Refund }
  write mail-[:Messages]-> { To: ["cfo@example.com"], Subject: "Refund", Body: "Open \${form.Url}" }
  r = race(
    () => { return await form-[:Submissions]-> },
    () => { await sleep(2d) },
  )
  if (r[0] == null) { fail("nobody answered within two days") }
  if (r[0].Approve) { return coalesce(r[0].Note, "approved") }
}
\`\`\`

- \`Fields\` names a node the program declares. A submission has its fields, typed as the node says: \`r[0].Approve\` is a boolean.
- A field may be text, a number, a boolean, a date, a date and time, or one of a set of words. \`<… | null>\` makes it optional.
- The link answers a browser with the form, and \`Accept: application/json\` with \`{ title, fields }\`, each field's \`type\` and \`required\`. A POST of JSON or a form records the answer.
- A form takes one answer. A different later one is answered 410; the same one sent again is the same answer. A value of the wrong kind is answered 400, naming the field, and records nothing.
- A form never expires. A wait on a person sits in a \`race\` with a \`sleep\`.`;

export const FORMS_MANIFEST: AdapterManifest = {
  adapterType: FORMS_ADAPTER_TYPE,
  displayName: 'Forms',
  description:
    'A form at a link, answered once. A write makes it; the node the write names in Fields says what it asks, and its answer lands on the form’s Submissions, typed by that node.',
  handbookSection: { title: 'Forms', content: HANDBOOK },
  supportedTriggers: [],
  methods: ['listEntryPoints', 'describe', 'getFieldValue', 'createRecord', 'checkInbound', 'awaitKeys'],
};
