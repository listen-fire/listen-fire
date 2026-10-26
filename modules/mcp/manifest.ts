// The MCP module's manifest: data only, so a host can list it without loading
// the adapter. Its types are not here: each connection's come from its own
// server's tool list, read when the connection is described.

import type { AdapterManifest } from 'movement-engine/public/adapter';

export const MCP_ADAPTER_TYPE = 'mcp';

const HANDBOOK = `## MCP servers

\`mcp\` connects any remote MCP server (streamable HTTP). Each connection names its own server, so one project can connect several, and each connection's types are that server's tools, read when it is described (\`lf check\`). A changed tool list takes effect at the next check.

- A tool that changes things is a type you write: its arguments are the fields, and its answer is read off the handle.
- A read-only tool (its server marks it \`readOnlyHint\`, and not destructive) is a type you read from the connection: its arguments are the \`==\` tests of the hop's \`WHERE\`, and it answers one record holding them and the answer.
- Every answer has \`text\` (its text parts, joined) and \`content\` (every part, as json). A tool with an output schema adds \`structured\` (the whole answer, as json) and one field per top-level output property.
- A refused call fails the run with the server's own text.

\`\`\`
import { acme_crm, mcp } from adapters
import { acme, linear } from credentials

crm = connect acme_crm using acme
tracker = connect mcp using linear

function triage(company: <crm-[:Company]->>) {
  issue = write tracker-[:create_issue]-> { title: "Follow up \${company.Name}", team: "ENG" }
  tracker-[r:search_issues WHERE r.query == company.Name]-> {
    write crm-[:Company]-> { Name: "\${r.count} open; \${issue.text}" }
  }
}

listen to crm { events: ["company.created"] } fire triage
\`\`\`

- A read must pin each argument its tool requires with \`==\` in the \`WHERE\` (a literal, or a value already in hand). One left out passes the check and fails the run, naming it. A read answers one record, so it takes no \`LIMIT\`.
- An argument's type follows the tool's input schema: text, number, boolean, date (a \`date\` string), a choice of values, or a list of one of those. Anything else (an object, a mixed list) is json.
- A result field an argument already names is left out; its value is still in \`content\`.`;

export const MCP_MANIFEST: AdapterManifest = {
  adapterType: MCP_ADAPTER_TYPE,
  displayName: 'MCP server',
  website: 'https://modelcontextprotocol.io',
  description: "Any remote MCP server. Each connection names its server; its tools become types a movement writes (a tool that changes things) or reads (a read-only tool).",
  handbookSection: { title: 'MCP servers', content: HANDBOOK },
  supportedTriggers: [],
  methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'deleteRecord'],
};
